/**
 * WaveformPort — the portable contract for computing render-ready waveform
 * peaks from an audio blob. Concrete providers live in the outbound adapters,
 * never in `@antiphony/core`.
 *
 * **Derived, not byte-mutating.** This is pure analysis over whatever variant
 * is current: it reads bytes and produces numbers, and never writes a blob or
 * touches `processedBlobCid`. That classification is what puts it in
 * `DERIVED_STAGES`, which is what makes it eligible for auto-recompute when a
 * byte-mutating stage changes the audio underneath it.
 *
 * **Local compute**, like trim — no API key, so the stage is available on its
 * binary alone.
 */
export interface WaveformInput {
    bytes: Uint8Array;
    mimeType: string;
}

export interface WaveformResult {
    /**
     * Peaks normalized to 0–100, at most 1000 of them — the same bounds as the
     * client-supplied `embed.waveform` in `shared/types/audio.ts`, so the two
     * are interchangeable at the render site and step 7 can resolve between
     * them per post without a renderer caring which it got.
     *
     * How many peaks, and what they are normalized against, are adapter
     * implementation detail and deliberately not in this contract — the same
     * reasoning that keeps the trimmer's threshold and pad out of
     * `TrimmerPort`. Tuning the visual density must not be a contract change.
     */
    peaks: number[];
}

export interface WaveformPort {
    waveform(input: WaveformInput): Promise<WaveformResult>;
}
