import { getAdminDb } from '../../../lib/firebase-admin.js';
import { COLLECTIONS, NSID } from 'shared/nsid';
import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import { cidForBytes } from '../../../lib/cid.js';
import { blobObjectPath } from '../../../lib/blob-path.js';
import { StorageService } from './core-services-firebase.js';
import { firebaseAudioPostDependencies } from './audio-posts-dependencies.js';
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

export const firebaseAudioProcessingDependencies: AudioProcessingDependencies = {
    // Reuse the post surface's tenancy-checked read (wrapped so the binding is
    // resolved at call time, not module-eval — these two modules form a cycle).
    getPostById: (originAppId, postId) =>
        firebaseAudioPostDependencies.getPostById(originAppId, postId),

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
        // leaving sibling stages untouched.
        const update: Record<string, unknown> = { 'processing.updatedAt': new Date() };
        if (patch.transcribe !== undefined) update['processing.transcribe'] = patch.transcribe;
        if (patch.denoise !== undefined) update['processing.denoise'] = patch.denoise;
        if (patch.denoisedBlobCid !== undefined) update['processing.denoisedBlobCid'] = patch.denoisedBlobCid;
        await postsCollection().doc(postId).update(update);
    },

    newTranscriptId(): string {
        return transcriptsCollection().doc().id;
    },

    now(): Date {
        return new Date();
    },
};
