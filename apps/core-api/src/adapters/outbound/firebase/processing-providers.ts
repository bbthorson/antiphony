import type { TranscriberPort } from '@antiphony/core/ports/transcription';
import type { DenoiserPort } from '@antiphony/core/ports/audio-denoiser';

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
