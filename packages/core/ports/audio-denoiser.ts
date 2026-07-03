/**
 * DenoiserPort — the portable contract for producing a cleaned (denoised /
 * voice-isolated) variant of an audio blob. Bytes in, bytes out. Concrete
 * providers (e.g. an external audio-isolation API, a dev stub) live in the
 * outbound adapters, never in `@antiphony/core`.
 *
 * The cleaned bytes are stored as their OWN content-addressed blob; the
 * original is never mutated (its CID is the record's immutable content
 * address). The view swaps playback to the cleaned variant when it exists.
 */
export interface DenoiseInput {
    bytes: Uint8Array;
    mimeType: string;
}

export interface DenoiseResult {
    bytes: Uint8Array;
    mimeType: string;
}

export interface DenoiserPort {
    denoise(input: DenoiseInput): Promise<DenoiseResult>;
}
