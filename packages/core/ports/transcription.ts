import type { TimedTranscript } from 'shared/types/audio';

/**
 * Audio bytes handed to a transcriber. The service reads them from the blob
 * store (the denoised variant when denoise ran, else the original).
 */
export interface TranscriptionInput {
    bytes: Uint8Array;
    mimeType: string;
    /** Duration hint (ms), when known — lets a provider bound its request. */
    durationMs?: number;
    /** BCP-47 language hint (the post's first `langs` entry), when present. */
    langHint?: string;
}

export interface TranscriptionResult {
    transcript: TimedTranscript;
    /** BCP-47 language the provider detected/used, if it reports one. */
    lang?: string;
    /** Provider/model identifier, recorded as transcript provenance. */
    model: string;
}

/**
 * TranscriberPort — the portable contract for turning audio into a timed
 * transcript. Pure interface: concrete providers (Gemini, a dedicated ASR, a
 * dev stub) live in the outbound adapters, never in `@antiphony/core`.
 *
 * Note on timings: the `TimedTranscript` shape asks for `{ startMs, endMs }`
 * segments. A provider that can't produce reliable per-segment timings may
 * return a single segment spanning the whole clip plus the `text` rollup —
 * the schema allows it, and consumers that don't need timing still work.
 */
export interface TranscriberPort {
    transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
