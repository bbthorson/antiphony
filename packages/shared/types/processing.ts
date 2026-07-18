import { z } from 'zod';
import { FirestoreTimestampSchema } from './records';

/**
 * Audio hygiene / enrichment processing (B5).
 *
 * Antiphony can, when the calling app opts in, run audio processing on a
 * post's audio. Four stages, classified on two axes (see
 * `specs/enrichment-pipeline.md`):
 *
 *  - **Byte-mutating** (`denoise`, `trim`) produce new audio. They compose in
 *    order into a SINGLE processed variant — trimmed-and-denoised audio is one
 *    artifact, not two — addressed by `processedBlobCid`.
 *  - **Derived** (`transcribe`, `waveform`) are pure analysis over the final
 *    variant and modify no audio. Because they are a function of the variant,
 *    recomputation is always the correct response to their input changing.
 *
 * Every stage is OFF by default — the app asks for them per post via
 * `CreateAudioPostRequest.processing`, or after the fact via
 * `POST /posts/{postId}/processing`.
 *
 * The work runs asynchronously (outside the create request), so a post
 * carries a mutable `processing` state that starts `pending` and settles to
 * `ready`/`failed`/`skipped` per stage. That state is a storage-layer field —
 * it is NOT part of the canonical lexicon record and never enters the record
 * CID (like `kind` and `threadParticipants`), so processing can update it
 * without changing the post's content address.
 *
 * That immutability is why stage OUTPUT lives here rather than on the embed:
 * `embed.audio.ref.$link`, `embed.durationMs`, and `embed.waveform` are inside
 * the CID and can never be rewritten. The read-time view resolves per field
 * between the record's canonical values and the variant values below.
 */

/**
 * Per-stage status.
 *  - `pending`  — requested, not yet done (the worker acts on these).
 *  - `ready`    — completed.
 *  - `failed`   — attempted and errored.
 *  - `skipped`  — requested but this deployment has no provider for it.
 *
 * A stage returning to `pending` after having been `ready` is NORMAL, not a
 * regression: a byte-mutating stage completing invalidates derived artifacts,
 * which are then recomputed. Clients treat any `pending` stage as "still
 * working", which already covers this.
 */
export const ProcessingStageStatusSchema = z.enum(['pending', 'ready', 'failed', 'skipped']);
export type ProcessingStageStatus = z.infer<typeof ProcessingStageStatusSchema>;

/**
 * The stage names, in the order a multi-stage request runs them:
 * denoise → trim → (transcribe, waveform).
 *
 * All byte-mutating stages run first; the two derived stages then consume the
 * final variant and are mutually independent. Denoise precedes trim
 * deliberately — silence detection keys off a noise floor, so on noisy input
 * the "silence" is not actually quiet and trim under-cuts.
 */
export const PROCESSING_STAGES = ['denoise', 'trim', 'transcribe', 'waveform'] as const;
export const ProcessingStageSchema = z.enum(PROCESSING_STAGES);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

/** Stages that produce new audio bytes, composing into one processed variant. */
export const BYTE_MUTATING_STAGES = ['denoise', 'trim'] as const satisfies readonly ProcessingStage[];

/** Stages that are pure analysis over the final variant, modifying no audio. */
export const DERIVED_STAGES = ['transcribe', 'waveform'] as const satisfies readonly ProcessingStage[];

/**
 * What the calling app opts into, on `CreateAudioPostRequest`. All default
 * off; only `true` values request a stage.
 */
export const ProcessingRequestSchema = z.object({
    transcribe: z.boolean().optional(),
    denoise: z.boolean().optional(),
    trim: z.boolean().optional(),
    waveform: z.boolean().optional(),
});
export type ProcessingRequest = z.infer<typeof ProcessingRequestSchema>;

/**
 * Per-stage status across all stages — the shape shared by the stored state,
 * the hydrated view, and the resolved-initial-state handoff between the route
 * and the service. A key is present iff that stage was requested.
 */
export const ProcessingStageMapSchema = z.object({
    transcribe: ProcessingStageStatusSchema.optional(),
    denoise: ProcessingStageStatusSchema.optional(),
    trim: ProcessingStageStatusSchema.optional(),
    waveform: ProcessingStageStatusSchema.optional(),
});
export type ProcessingStageMap = z.infer<typeof ProcessingStageMapSchema>;

/**
 * Stored processing state on the post record (storage-layer; not in the CID):
 * the per-stage statuses plus the output of the stages themselves.
 *
 * The variant fields below all exist for the same reason — their canonical
 * counterparts live inside the record CID and cannot be updated:
 *
 *  - `processedBlobCid` ↔ `embed.audio.ref.$link`
 *  - `processedDurationMs` ↔ `embed.durationMs` (trim changes duration)
 *  - `waveform` ↔ `embed.waveform` (the client's peaks describe the original)
 */
export const ProcessingStateSchema = ProcessingStageMapSchema.extend({
    /**
     * Content CID of the processed audio variant — the composed output of every
     * byte-mutating stage that has completed. The record's own
     * `embed.audio.ref.$link` stays the ORIGINAL CID (immutable content
     * address); only the read-time view swaps playback to this variant.
     */
    processedBlobCid: z.string().optional(),
    /**
     * Duration of the processed variant, when a byte-mutating stage changed it
     * (i.e. trim). Absent when the variant's duration matches the original.
     */
    processedDurationMs: z.number().int().min(0).optional(),
    /**
     * Peaks for the processed variant, once the `waveform` stage completes.
     * Same normalization and bounds as `embed.waveform` (0–100, max 1000), so
     * a view can never carry a larger payload than the record allows.
     */
    waveformPeaks: z.array(z.number().int().min(0).max(100)).max(1000).optional(),
    updatedAt: FirestoreTimestampSchema,
});
export type ProcessingState = z.infer<typeof ProcessingStateSchema>;

/**
 * The processing status surfaced on the hydrated view — the per-stage status
 * only (no internal storage fields: variant CID, duration, peaks, timestamps).
 * Absent when no processing was requested.
 */
export const ProcessingViewSchema = ProcessingStageMapSchema;
export type ProcessingView = z.infer<typeof ProcessingViewSchema>;

/** Project the stored state onto the view — drops every internal field. */
export function toProcessingView(state: ProcessingState): ProcessingView {
    return {
        transcribe: state.transcribe,
        denoise: state.denoise,
        trim: state.trim,
        waveform: state.waveform,
    };
}
