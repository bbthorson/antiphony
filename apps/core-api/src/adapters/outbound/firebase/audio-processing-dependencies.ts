import admin from 'firebase-admin';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { COLLECTIONS, NSID } from 'shared/nsid';
import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import { cidForBytes } from '../../../lib/cid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { StorageService } from './core-services-firebase.js';
import { firebaseAudioPostDependencies } from './audio-posts-dependencies.js';
import { getAppDid as resolveAppDid } from '../../../lib/app-did.js';
import type { AudioProcessingDependencies } from '@antiphony/core/ports/audio-processing-dependencies';

export type { AudioProcessingDependencies };

/**
 * Firebase-wired `AudioProcessingDependencies` binding (B5). Reuses the same
 * collections (`posts`, `audio_transcripts`) and content-addressed blob paths
 * as the post surface — a denoised variant is just another blob under
 * `blobs/{originAppId}/{cid}`, so playback resolution needs no new scheme.
 */

function postsCollection() {
    return getAdminDb().collection(COLLECTIONS[NSID.AudioPost]);
}

function transcriptsCollection() {
    return getAdminDb().collection(COLLECTIONS[NSID.AudioTranscript]);
}

/** Single clock for this binding, so every timestamp it stamps is consistent. */
function now(): Date {
    return new Date();
}

export const firebaseAudioProcessingDependencies: AudioProcessingDependencies = {
    // Reuse the post surface's tenancy-checked read (wrapped so the binding is
    // resolved at call time, not module-eval — these two modules form a cycle).
    getPostById: (originAppId, postId) =>
        firebaseAudioPostDependencies.getPostById(originAppId, postId),

    // Same boot-validated pin snapshot the post surface resolves through.
    getAppDid(originAppId: string): string {
        return resolveAppDid(originAppId);
    },

    async readBlobBytes(originAppId, blobCid) {
        const path = blobObjectPath(originAppId, blobCid);
        if (!path) return null;
        return StorageService.download(path);
    },

    async writeDerivedBlob(originAppId, bytes, mimeType) {
        const buf = Buffer.from(bytes);
        const cid = await cidForBytes(buf);
        const path = blobObjectPath(originAppId, cid);
        if (!path) throw new Error('derived blob path could not be derived');
        await StorageService.uploadFile(buf, path, mimeType);
        return cid;
    },

    async saveTranscript(record: TranscriptEnrichmentRecord) {
        // The id is the doc id, not a stored field (mirrors how transcripts
        // are read back in audio-posts-dependencies).
        const { id, ...data } = record;
        await transcriptsCollection().doc(id).set(data);
    },

    async patchProcessingState(_originAppId, postId, patch) {
        // Dotted field paths update just these leaves of the `processing` map,
        // leaving sibling stages untouched. Driven off the patch's own keys
        // rather than a hand-maintained allowlist: an allowlist that falls
        // behind the schema drops writes SILENTLY, which for a stage's output
        // means the state says `ready` while the artifact went nowhere.
        const update: Record<string, unknown> = { 'processing.updatedAt': now() };
        for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) update[`processing.${key}`] = value;
        }
        await postsCollection().doc(postId).update(update);
    },

    async claimProcessingLease(_originAppId, postId, leaseUntil) {
        // One transaction, so the read of the existing lease and the write of
        // the new one cannot interleave with another runner doing the same.
        // Read-then-write outside a transaction would let both runners observe
        // "unheld" and both proceed — the exact race this closes.
        return getAdminDb().runTransaction(async (t) => {
            const ref = postsCollection().doc(postId);
            const snap = await t.get(ref);
            if (!snap.exists) return false;
            const processing = snap.data()?.processing as
                | { leaseUntil?: { toMillis?: () => number } }
                | undefined;
            // No processing state means nothing to claim. Claiming anyway
            // would CREATE the `processing` map on a post that never requested
            // any, and the service treats a present map as "processing was
            // requested" — so a no-op job would permanently change how the
            // post reads.
            if (!processing) return false;
            const heldUntil = processing.leaseUntil?.toMillis?.();
            // Strictly-greater: a lease expiring exactly now is expired.
            if (heldUntil && heldUntil > Date.now()) return false;
            t.update(ref, { 'processing.leaseUntil': leaseUntil });
            return true;
        });
    },

    async releaseProcessingLease(_originAppId, postId) {
        // Deleted rather than set to a past time, so the absent case and the
        // released case are one state instead of two that read differently.
        await postsCollection()
            .doc(postId)
            .update({ 'processing.leaseUntil': admin.firestore.FieldValue.delete() });
    },

    newTranscriptId(): string {
        return transcriptsCollection().doc().id;
    },

    now,
};
