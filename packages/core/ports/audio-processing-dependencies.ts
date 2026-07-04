import type { AudioPostRecord, TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ProcessingState } from 'shared/types/processing';

/**
 * Data/storage port the `AudioProcessingService` uses to run one post's audio
 * processing. The Firebase-backed binding lives in
 * `apps/core-api/src/adapters/outbound/firebase/audio-processing-dependencies.ts`.
 *
 * Kept separate from `AudioPostDependencies` (which serves the read/write
 * post surface) so the processing worker's needs — reading blob bytes,
 * writing a derived blob, saving the transcript enrichment, patching the
 * processing state — are an explicit, self-contained contract.
 */
export interface AudioProcessingDependencies {
    /** Load the post to process, scoped to its origin app. Null if gone/cross-tenant. */
    getPostById(originAppId: string, postId: string): Promise<AudioPostRecord | null>;

    /**
     * Resolve a tenant (`originAppId`) to its **app DID** — the `at://`
     * authority used when building the transcript's subject uri. Fail-closed
     * for an unpinned/unvalidated tenant. Backed by the boot-validated pin
     * snapshot in the adapter; mirrors `AudioPostDependencies.getAppDid`.
     */
    getAppDid(originAppId: string): string;

    /**
     * Read a stored blob's raw bytes by content CID, tenancy-scoped. Null if
     * absent. (MIME type isn't returned — the caller already has it from the
     * record's `embed.audio.mimeType`, so this avoids a metadata round-trip.)
     */
    readBlobBytes(originAppId: string, blobCid: string): Promise<Uint8Array | null>;

    /**
     * Store derived (e.g. denoised) audio bytes as their own content-addressed
     * blob and return its CID. Same content-addressing as upload, so an
     * identical derivation is idempotent (re-storing lands on the same object).
     */
    writeDerivedBlob(originAppId: string, bytes: Uint8Array, mimeType: string): Promise<string>;

    /** Persist a transcript enrichment record (last-write-wins by subject uri). */
    saveTranscript(record: TranscriptEnrichmentRecord): Promise<void>;

    /**
     * Merge a partial processing-state patch onto the post (sets `updatedAt`).
     * Used per stage so progress is observable as each finishes.
     */
    patchProcessingState(
        originAppId: string,
        postId: string,
        patch: Partial<Omit<ProcessingState, 'updatedAt'>>,
    ): Promise<void>;

    /** Generate a new unique transcript record id. */
    newTranscriptId(): string;

    /** Current server time. */
    now(): Date;
}
