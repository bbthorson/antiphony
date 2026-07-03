import { z } from 'zod';
import { FirestoreTimestampSchema } from './records';

/**
 * Audio hygiene / enrichment processing (B5).
 *
 * Antiphony can, when the calling app opts in, run two pieces of audio
 * processing on a post's audio: **transcription** (machine transcript, the
 * `dev.antiphony.audio.transcript` enrichment) and **denoise** (a cleaned
 * audio variant for playback). Both are OFF by default — the app asks for
 * them per post via `CreateAudioPostRequest.processing`.
 *
 * The work runs asynchronously (outside the create request), so a post
 * carries a mutable `processing` state that starts `pending` and settles to
 * `ready`/`failed`/`skipped` per stage. That state is a storage-layer field —
 * it is NOT part of the canonical lexicon record and never enters the record
 * CID (like `kind` and `threadParticipants`), so processing can update it
 * without changing the post's content address.
 */

/**
 * Per-stage status.
 *  - `pending`  — requested, not yet done (the worker acts on these).
 *  - `ready`    — completed.
 *  - `failed`   — attempted and errored.
 *  - `skipped`  — requested but this deployment has no provider for it.
 */
export const ProcessingStageStatusSchema = z.enum(['pending', 'ready', 'failed', 'skipped']);
export type ProcessingStageStatus = z.infer<typeof ProcessingStageStatusSchema>;

/**
 * What the calling app opts into, on `CreateAudioPostRequest`. Both default
 * off; only `true` values request a stage.
 */
export const ProcessingRequestSchema = z.object({
    transcribe: z.boolean().optional(),
    denoise: z.boolean().optional(),
});
export type ProcessingRequest = z.infer<typeof ProcessingRequestSchema>;

/**
 * Stored processing state on the post record (storage-layer; not in the CID).
 * A stage key is present iff that stage was requested. `denoisedBlobCid`
 * points at the cleaned audio variant once denoise completes — the record's
 * own `embed.audio.ref.$link` stays the ORIGINAL CID (immutable content
 * address); only the read-time view swaps playback to the cleaned variant.
 */
export const ProcessingStateSchema = z.object({
    transcribe: ProcessingStageStatusSchema.optional(),
    denoise: ProcessingStageStatusSchema.optional(),
    /** Content CID of the denoised audio variant, once `denoise === 'ready'`. */
    denoisedBlobCid: z.string().optional(),
    updatedAt: FirestoreTimestampSchema,
});
export type ProcessingState = z.infer<typeof ProcessingStateSchema>;

/**
 * The processing status surfaced on the hydrated view — the per-stage status
 * only (no internal storage fields). Absent when no processing was requested.
 * Clients treat any `pending` stage as "still working".
 */
export const ProcessingViewSchema = z.object({
    transcribe: ProcessingStageStatusSchema.optional(),
    denoise: ProcessingStageStatusSchema.optional(),
});
export type ProcessingView = z.infer<typeof ProcessingViewSchema>;
