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
    /**
     * Provider/model identifier, when the provider reports or fixes one —
     * provenance, mirroring `TranscriptionResult.model`.
     *
     * On the RESULT, never on the input: a model name reaching `DenoiseInput`
     * would let core name a vendor model, which is the leak the provider policy
     * exists to prevent. Reported back, it is portable — a Whisper-family
     * adapter says `whisper-large-v3` and nothing upstream cares.
     *
     * Optional because not every denoiser has a model to name (the stub is a
     * pass-through), and because unlike a transcript there is nowhere durable
     * to put this yet: a cleaned variant is a blob CID on `ProcessingState`,
     * not a record of its own. Persisting it is deliberately deferred until a
     * second denoiser exists to make the question concrete — see
     * `specs/provider-selection.md` § 3.2.
     */
    model?: string;
}

export interface DenoiserPort {
    denoise(input: DenoiseInput): Promise<DenoiseResult>;
}
