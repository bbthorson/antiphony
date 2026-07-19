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

    /**
     * Claim exclusive right to process this post until `leaseUntil`. Returns
     * true when the claim succeeded and the caller may proceed.
     *
     * **Must be atomic** — a read-then-write implementation reintroduces
     * exactly the race it exists to close. The Firebase binding does it in a
     * transaction.
     *
     * Returns false in three cases, deliberately not distinguished:
     *   - another runner holds an unexpired lease,
     *   - the post is gone or belongs to another tenant,
     *   - the post has no `processing` state, so there is nothing to claim.
     *
     * They collapse because the caller's response is identical in all three —
     * stop, without treating it as an error — and because distinguishing them
     * would mean returning post state through a method whose job is the claim.
     * The service reads the post after claiming, which is where "gone" is
     * reported.
     *
     * An expired lease is claimable: a runner that died mid-pass never
     * released, and the post must not be stranded on that account. This means
     * a lease that lapses under a still-running holder permits a genuine
     * overlap, so the TTL has to exceed the longest plausible pass.
     */
    claimProcessingLease(originAppId: string, postId: string, leaseUntil: Date): Promise<boolean>;

    /**
     * Release this post's lease, making it immediately claimable again.
     *
     * Called in a `finally`, so a stage that throws does not hold the post for
     * the full TTL. Best-effort by nature: if the runner dies before reaching
     * it, expiry is the backstop.
     *
     * `leaseUntil` is the value this runner claimed, and acts as a fencing
     * token: the release must be a no-op unless the stored lease is still
     * that exact one. A runner whose lease lapsed mid-pass has already been
     * superseded, and an unconditional delete there would clear the *new*
     * holder's claim — re-opening the post to a third runner while the second
     * is still working, which is the overlap the lease exists to prevent.
     */
    releaseProcessingLease(originAppId: string, postId: string, leaseUntil: Date): Promise<void>;

    /** Generate a new unique transcript record id. */
    newTranscriptId(): string;

    /** Current server time. */
    now(): Date;
}
