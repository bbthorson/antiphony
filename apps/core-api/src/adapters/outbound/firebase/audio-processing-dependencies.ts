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

/**
 * Millis for a stored `leaseUntil`, or undefined if there isn't one.
 *
 * Real Firestore hands back a `Timestamp`, but a `Date` goes in on the write
 * and in-memory doubles read it straight back out that way. Handling only
 * `toMillis` makes every lease check silently answer "unheld" against a
 * double — the check would compile, pass, and protect nothing.
 */
function leaseMillis(value: unknown): number | undefined {
    if (value instanceof Date) return value.getTime();
    const ts = value as { toMillis?: () => number } | undefined;
    return typeof ts?.toMillis === 'function' ? ts.toMillis() : undefined;
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
            const processing = snap.data()?.processing as { leaseUntil?: unknown } | undefined;
            // No processing state means nothing to claim. Claiming anyway
            // would CREATE the `processing` map on a post that never requested
            // any, and the service treats a present map as "processing was
            // requested" — so a no-op job would permanently change how the
            // post reads.
            if (!processing) return false;
            const heldUntil = leaseMillis(processing.leaseUntil);
            // Strictly-greater: a lease expiring exactly now is expired.
            // Read against this binding's own clock, the same one that stamps
            // every other timestamp here.
            if (heldUntil !== undefined && heldUntil > now().getTime()) return false;
            t.update(ref, { 'processing.leaseUntil': leaseUntil });
            return true;
        });
    },

    async releaseProcessingLease(_originAppId, postId, leaseUntil) {
        // Compare-and-delete, in a transaction for the same reason the claim
        // is: read-then-write outside one would let the stored lease change
        // between the check and the delete.
        //
        // The check is the fencing token. A pass that outran its own lease has
        // already been superseded by whoever claimed next, and deleting
        // unconditionally there would hand a THIRD runner the post while the
        // second is still mid-pass — restoring exactly the concurrent-write
        // hazard the lease closes, and doing it at the moment the system is
        // already running slow enough to have caused it.
        await getAdminDb().runTransaction(async (t) => {
            const ref = postsCollection().doc(postId);
            const snap = await t.get(ref);
            if (!snap.exists) return;
            const processing = snap.data()?.processing as { leaseUntil?: unknown } | undefined;
            if (leaseMillis(processing?.leaseUntil) !== leaseUntil.getTime()) return;
            // Deleted rather than set to a past time, so the absent case and
            // the released case are one state instead of two that read
            // differently.
            t.update(ref, { 'processing.leaseUntil': admin.firestore.FieldValue.delete() });
        });
    },

    newTranscriptId(): string {
        return transcriptsCollection().doc().id;
    },

    now,
};
