/**
 * TrimmerPort — the portable contract for trimming silence off an audio blob.
 * Bytes in, bytes out, mirroring `DenoiserPort`. Concrete providers live in the
 * outbound adapters, never in `@antiphony/core`.
 *
 * Byte-mutating, like denoise: the trimmed bytes are stored as their OWN
 * content-addressed blob and compose into the same `processedBlobCid`. The
 * original is never mutated — its CID is the record's immutable content
 * address.
 *
 * **Policy is deliberately fixed and conservative, and belongs to the adapter,
 * not this contract:**
 *
 * - **Leading and trailing only.** Interior gaps are left alone; they are
 *   often deliberate (a pause for effect, a breath between clauses), and an
 *   aggressive interior cut is not recoverable from the variant.
 * - **Pad rather than cut to the first sample of speech.** Trimming to the
 *   exact onset clips plosives and makes the result sound truncated, which is
 *   worse than leaving a little room.
 * - Threshold and pad length are adapter implementation detail. They are not
 *   in this interface precisely so tuning them is not a contract change.
 *
 * Ordering: runs AFTER denoise, because silence detection needs the noise floor
 * gone first — a noisy recording has no silence to find.
 */
export interface TrimInput {
    bytes: Uint8Array;
    mimeType: string;
}

export interface TrimResult {
    bytes: Uint8Array;
    /**
     * The mime type of the RETURNED bytes, which need not match the input.
     *
     * A trimmer decodes and re-encodes, so it may legitimately change format —
     * and the reference adapter does exactly that on purpose, to undo the
     * ~2.5x storage inflation of Voice Isolator's 320 kbps CBR MP3 output.
     * Echoing the input type instead would store bytes under a label that does
     * not describe them, which fails silently: blobs are served to browsers
     * with their stored content type, so playback breaks with no exception, no
     * failed stage, and nothing in the logs. Same trap the denoiser adapter
     * hit against a real provider.
     */
    mimeType: string;
    /**
     * Duration of the trimmed variant in milliseconds, for
     * `ProcessingState.processedDurationMs`.
     *
     * The record's `embed.durationMs` describes the ORIGINAL and is inside the
     * immutable record CID, so it can never be corrected. Trimming is the first
     * stage that makes the two genuinely differ, which is what step 7's
     * per-field variant resolution exists to reconcile.
     */
    durationMs: number;
}

export interface TrimmerPort {
    trim(input: TrimInput): Promise<TrimResult>;
}
