import { getAdminDb } from '../../../lib/firebase-admin.js';
import {
    AudioPostRecordSchema,
    TranscriptEnrichmentRecordSchema,
    type AudioPostRecord,
    type TranscriptEnrichmentRecord,
} from 'shared/types/audio';
import { COLLECTIONS, NSID } from 'shared/nsid';
import { logger } from '../../../lib/logger.js';
import { cidForRecord } from '../../../lib/cid.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';
import { newTid } from '../../../lib/tid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { StorageService } from './core-services-firebase.js';
import type {
    AudioPostDependencies,
    AudioPostQueryOptions,
    AudioPostThreadOptions,
} from '@antiphony/core/ports/audio-posts-dependencies';

export type { AudioPostDependencies, AudioPostQueryOptions, AudioPostThreadOptions };

/**
 * Firebase-wired `AudioPostDependencies` binding for core-api (Stream 1 PR2).
 *
 * Backs the new `/posts` surface for the Antiphony `dev.antiphony.audio.post`
 * model. Fully additive — it owns its own collections (`posts`,
 * `audio_transcripts`, both derived from the NSID→collection map) and never
 * touches the legacy `prompts`/`replies` bindings.
 */

// Firestore `in` queries cap at 30 disjuncts — chunk the transcript lookup.
const FIRESTORE_IN_LIMIT = 30;

function postsCollection() {
    return getAdminDb().collection(COLLECTIONS[NSID.AudioPost]);
}

function transcriptsCollection() {
    return getAdminDb().collection(COLLECTIONS[NSID.AudioTranscript]);
}

function parsePostDocs(snapshot: FirebaseFirestore.QuerySnapshot): AudioPostRecord[] {
    const out: AudioPostRecord[] = [];
    for (const doc of snapshot.docs) {
        const parsed = AudioPostRecordSchema.safeParse({ id: doc.id, ...doc.data() });
        if (!parsed.success) {
            logger.error(
                { docId: doc.id, issues: parsed.error.issues },
                '[audio-posts-deps] AudioPostRecord validation failed; skipping',
            );
            continue;
        }
        out.push(parsed.data);
    }
    return out;
}

async function startAfterCursor(
    q: FirebaseFirestore.Query,
    cursorId: string | undefined,
): Promise<FirebaseFirestore.Query> {
    if (!cursorId) return q;
    const snap = await postsCollection().doc(cursorId).get();
    return snap.exists ? q.startAfter(snap) : q;
}

export const firebaseAudioPostDependencies: AudioPostDependencies = {
    // Mint a TID (the AT-Proto record-key format) rather than a Firestore
    // auto-id: it becomes the `rkey` in `at://{appDid}/{collection}/{rkey}`, so
    // the id must be an honest, time-sortable record key a real PDS would emit.
    // Also used verbatim as the Firestore document id (13 lowercase alnum chars).
    newPostId(): string {
        return newTid();
    },

    // Serves from the boot-validated pin snapshot (lib/app-did.ts); throws for
    // an unpinned/unvalidated tenant. Keeps `@antiphony/core` config-free.
    getAppDid(originAppId: string): string {
        return resolveAppDid(originAppId);
    },

    async savePost(record: AudioPostRecord): Promise<void> {
        await postsCollection().doc(record.id).set(record);
    },

    async getPostById(originAppId: string, id: string): Promise<AudioPostRecord | null> {
        if (!id || !id.trim()) return null;
        const snap = await postsCollection().doc(id).get();
        if (!snap.exists) return null;
        const parsed = AudioPostRecordSchema.safeParse({ id: snap.id, ...snap.data() });
        if (!parsed.success) {
            logger.error(
                { docId: snap.id, issues: parsed.error.issues },
                '[audio-posts-deps] AudioPostRecord validation failed',
            );
            return null;
        }
        // Tenancy isolation: a post owned by a different origin app is invisible.
        if (parsed.data.originAppId !== originAppId) return null;
        return parsed.data;
    },

    async queryByAuthor(
        originAppId: string,
        authorId: string,
        options?: AudioPostQueryOptions,
    ): Promise<AudioPostRecord[]> {
        if (!originAppId?.trim() || !authorId?.trim()) return [];
        const { kind, limit = 20, cursorId } = options ?? {};

        let q: FirebaseFirestore.Query = postsCollection()
            .where('originAppId', '==', originAppId)
            .where('authorId', '==', authorId);
        if (kind) q = q.where('kind', '==', kind);
        q = q.orderBy('createdAt', 'desc').limit(limit);
        q = await startAfterCursor(q, cursorId);

        return parsePostDocs(await q.get());
    },

    async queryByRootAuthor(
        originAppId: string,
        rootAuthorId: string,
        options?: AudioPostQueryOptions,
    ): Promise<AudioPostRecord[]> {
        if (!originAppId?.trim() || !rootAuthorId?.trim()) return [];
        const { limit = 20, cursorId } = options ?? {};

        // `rootAuthorId` is reply-only (stamped at write), so this composite
        // query is inherently restricted to replies — no `kind` predicate.
        let q: FirebaseFirestore.Query = postsCollection()
            .where('originAppId', '==', originAppId)
            .where('rootAuthorId', '==', rootAuthorId)
            .orderBy('createdAt', 'desc')
            .limit(limit);
        q = await startAfterCursor(q, cursorId);

        return parsePostDocs(await q.get());
    },

    async queryReplies(
        originAppId: string,
        parentUri: string,
        options?: AudioPostThreadOptions,
    ): Promise<AudioPostRecord[]> {
        if (!originAppId?.trim() || !parentUri?.trim()) return [];
        const { limit = 50, cursorId } = options ?? {};

        let q: FirebaseFirestore.Query = postsCollection()
            .where('originAppId', '==', originAppId)
            .where('reply.parent.uri', '==', parentUri)
            .orderBy('createdAt', 'asc')
            .limit(limit);
        q = await startAfterCursor(q, cursorId);

        return parsePostDocs(await q.get());
    },

    async getTranscriptsBySubjectUris(
        uris: string[],
    ): Promise<Map<string, TranscriptEnrichmentRecord>> {
        const map = new Map<string, TranscriptEnrichmentRecord>();
        const unique = Array.from(new Set(uris.filter((u) => u && u.trim())));
        if (unique.length === 0) return map;

        const chunks: string[][] = [];
        for (let i = 0; i < unique.length; i += FIRESTORE_IN_LIMIT) {
            chunks.push(unique.slice(i, i + FIRESTORE_IN_LIMIT));
        }

        const snapshots = await Promise.all(
            chunks.map((chunk) =>
                transcriptsCollection().where('subject.uri', 'in', chunk).get(),
            ),
        );

        for (const snap of snapshots) {
            for (const doc of snap.docs) {
                const parsed = TranscriptEnrichmentRecordSchema.safeParse({
                    id: doc.id,
                    ...doc.data(),
                });
                if (!parsed.success) {
                    logger.error(
                        { docId: doc.id, issues: parsed.error.issues },
                        '[audio-posts-deps] transcript enrichment validation failed; skipping',
                    );
                    continue;
                }
                // Last write wins if a post somehow has multiple transcripts.
                map.set(parsed.data.subject.uri, parsed.data);
            }
        }
        return map;
    },

    async signAudioUrl(originAppId: string, blobCid: string): Promise<string | null> {
        // The stored ref is a content CID; the object path is DERIVED from it
        // (tenancy-scoped, deterministic — see lib/blob-path.ts), then a
        // short-lived signed URL is minted (same machinery as the audio proxy).
        const objectPath = blobObjectPath(originAppId, blobCid);
        if (!objectPath) return null;
        try {
            return await StorageService.getSignedUrl(objectPath);
        } catch (err) {
            logger.error({ err, objectPath }, '[audio-posts-deps] failed to sign audio URL');
            return null;
        }
    },

    cidForRecord,

    now(): Date {
        return new Date();
    },
};
