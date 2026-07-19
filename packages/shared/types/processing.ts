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
 * `CreateAudioPostRequest.processing`, or after the fact via the `processing`
 * opt-in on `PATCH /api/v1/posts/{postId}`.
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
    /**
     * Whether a completed byte-mutating stage should invalidate and recompute
     * the derived artifacts that describe the old audio. Defaults to **true**
     * — a transcript of superseded audio is wrong, not merely stale.
     *
     * `false` opts out, for an app that would rather keep the existing
     * transcript than pay to regenerate it. It does NOT name a stage, so a
     * request carrying only `reprocess` requests no work.
     */
    reprocess: z.boolean().optional(),
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
 * An opt-in request resolved against a deployment's capabilities: the initial
 * per-stage state plus the settings the async worker needs to honour it.
 *
 * `reprocess` is carried here — and persisted — rather than passed to the
 * worker as an argument, because the request that asks for the work and the
 * pass that performs it are separated by a queue (step 8). Written on every
 * request including the default, because the stored state is MERGED onto —
 * absent means true only for posts written before this field existed.
 */
export const ResolvedProcessingSchema = ProcessingStageMapSchema.extend({
    reprocess: z.boolean().optional(),
});
export type ResolvedProcessing = z.infer<typeof ResolvedProcessingSchema>;

/**
 * Stored processing state on the post record (storage-layer; not in the CID):
 * the per-stage statuses plus the output of the stages themselves.
 *
 * The variant fields below all exist for the same reason — their canonical
 * counterparts live inside the record CID and cannot be updated:
 *
 *  - `processedBlobCid` ↔ `embed.audio.ref.$link`
 *  - `processedMimeType` ↔ `embed.audio.mimeType` (providers may transcode)
 *  - `processedDurationMs` ↔ `embed.durationMs` (trim changes duration)
 *  - `waveformPeaks` ↔ `embed.waveform` (the client's peaks describe the original)
 */
export const ProcessingStateSchema = ResolvedProcessingSchema.extend({
    /**
     * Content CID of the processed audio variant — the composed output of every
     * byte-mutating stage that has completed. The record's own
     * `embed.audio.ref.$link` stays the ORIGINAL CID (immutable content
     * address); only the read-time view swaps playback to this variant.
     */
    processedBlobCid: z.string().optional(),
    /**
     * MIME type of the processed variant. Present because providers may
     * TRANSCODE — the ElevenLabs Voice Isolator returns MP3 regardless of what
     * it is given — so the variant's type cannot be assumed to match
     * `embed.audio.mimeType`. Anything reading the variant's bytes must use
     * this, not the embed's.
     */
    processedMimeType: z.string().optional(),
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
    /**
     * When the current runner's exclusive claim on this post expires.
     *
     * Queue delivery is at-least-once, so the same job can arrive twice and
     * run CONCURRENTLY. `process()` is idempotent under sequential retry — it
     * acts on `pending` and re-does nothing already settled — but two passes
     * interleaved is a different failure: both read the same `pending` state,
     * both bill the provider for the same stage, and both write
     * `processedBlobCid`, so the surviving variant is whichever finished last
     * and the other's blob is orphaned.
     *
     * A runner claims this field transactionally before doing any work and
     * clears it when finished; a second runner finding it unexpired declines
     * and returns. It is an EXPIRY, not a boolean lock, because the holder can
     * die mid-run (instance recycled, process killed) with no chance to
     * release — a plain flag would strand the post permanently, where a lapsed
     * lease lets the next delivery pick it up.
     *
     * Internal, like the variant fields above: `toProcessingView` projects
     * stages only, so this never reaches a client.
     */
    leaseUntil: FirestoreTimestampSchema.optional(),
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

/**
 * Project the stored state onto the view — drops every internal field.
 *
 * Derived from `PROCESSING_STAGES` rather than listing the stages by hand, so
 * a stage added to the set cannot be silently omitted from the view (which
 * would leave clients unable to tell "not requested" from "in progress").
 */
export function toProcessingView(state: ProcessingState): ProcessingView {
    const view: ProcessingView = {};
    for (const stage of PROCESSING_STAGES) {
        if (state[stage] !== undefined) view[stage] = state[stage];
    }
    return view;
}

/** The record's own audio fields — canonical, inside the CID, never rewritten. */
export interface CanonicalAudioFields {
    blobCid: string;
    durationMs?: number;
    waveform?: number[];
}

/**
 * Resolve the audio fields a reader should see: canonical from the record,
 * variant from `ProcessingState` wherever processing has superseded it.
 *
 * The three fields have to move together. Peaks are rendered ACROSS a duration
 * and a duration describes a specific set of bytes, so serving a processed URL
 * beside the original duration puts a scrubber out of alignment with the audio
 * under it — the failure this function exists to prevent.
 *
 * Resolution is not a uniform `??` per field, because the state's fields do not
 * all mean the same thing when absent:
 *
 *  - `processedDurationMs` absent is DEFINED as "the variant's duration equals
 *    the original" (denoise transcodes without retiming), so falling back to
 *    the record there is correct, not a guess.
 *  - `waveformPeaks` carries no such guarantee. Recompute marks the stage
 *    `pending` without clearing the field, so between a variant change and the
 *    recomputed peaks landing it holds peaks for the SUPERSEDED variant. Hence
 *    the status gate rather than a presence check.
 *
 * Peaks do not key off `processedBlobCid`: `waveform` always runs over the
 * final variant, so when it is `ready` its peaks describe whatever playback
 * resolves to here, variant or original alike.
 */
export function resolveAudioVariant(
    canonical: CanonicalAudioFields,
    state: ProcessingState | undefined,
): CanonicalAudioFields {
    if (!state) return canonical;

    // Duration tracks the variant, so it moves only when the bytes do.
    const hasVariant = state.processedBlobCid !== undefined;

    // KNOWN GAP, inherited deliberately: `ready` does not prove the peaks match
    // the current variant. When a variant changes and no runner is configured,
    // the stage is left `ready` over a stale artifact on purpose (see the
    // "stranded" branch in AudioProcessingService) and nothing on the state
    // distinguishes that from a fresh result. Closing it needs the peaks to
    // record which variant they describe, which is a state-schema change, not a
    // read-time one. Until then a stranded deployment can serve stale peaks —
    // the same exposure it already has for a stranded transcript.
    const peaksAreCurrent = state.waveform === 'ready' && state.waveformPeaks !== undefined;

    return {
        blobCid: hasVariant ? state.processedBlobCid! : canonical.blobCid,
        durationMs: hasVariant
            ? (state.processedDurationMs ?? canonical.durationMs)
            : canonical.durationMs,
        waveform: peaksAreCurrent ? state.waveformPeaks : canonical.waveform,
    };
}
