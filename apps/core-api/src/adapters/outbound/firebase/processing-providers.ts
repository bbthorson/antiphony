import type { TranscriberPort } from '@antiphony/core/ports/transcription';
import type { DenoiserPort } from '@antiphony/core/ports/audio-denoiser';
import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';

/**
 * Processing providers (B5).
 *
 * Sub-PR 1 ships only STUB providers, wired solely when
 * `ANTIPHONY_PROCESSING_STUB=true` (dev / tests) so the full create → process
 * → hydrate loop is exercisable without external services or secrets. The
 * real providers (Gemini transcription, ElevenLabs denoise) are single-fetch
 * adapters that land in a later PR and select off their API-key env vars;
 * this module is where they slot in.
 */

/** Placeholder transcriber — emits a clearly-marked stub, never a real transcript. */
export const stubTranscriber: TranscriberPort = {
    async transcribe(input) {
        const endMs = input.durationMs ?? 0;
        return {
            transcript: {
                segments: [{ startMs: 0, endMs, text: '[stub transcript]' }],
                text: '[stub transcript]',
            },
            lang: input.langHint,
            model: 'stub',
        };
    },
};

/** Placeholder denoiser — passes the bytes through unchanged. */
export const stubDenoiser: DenoiserPort = {
    async denoise(input) {
        return { bytes: input.bytes, mimeType: input.mimeType };
    },
};

/**
 * Placeholder trimmer — passes the bytes through unchanged and reports a
 * duration of 0.
 *
 * Deliberately does NOT echo a plausible duration: a stub that invents one
 * would let `processedDurationMs` look settled in dev while no decoding has
 * happened, which is exactly the kind of "valid-looking but wrong" state the
 * denoiser's mime-type trap produced against a real provider. Zero is
 * obviously a stub.
 */
export const stubTrimmer: TrimmerPort = {
    async trim(input) {
        return { bytes: input.bytes, mimeType: input.mimeType, durationMs: 0 };
    },
};
