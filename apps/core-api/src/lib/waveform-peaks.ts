/**
 * Peak-envelope arithmetic for the ffmpeg waveform adapter, kept separate from
 * the subprocess so the policy is testable without the binary — same split as
 * `silence-trim.ts`, for the same reason.
 *
 * Everything here is pure: decoded PCM goes in, render-ready peaks come out.
 * The adapter owns spawning; this owns deciding.
 */

/** Upper bound on emitted peaks, matching `embed.waveform`'s `.max(1000)`. */
export const MAX_PEAKS = 1000;

/**
 * Peaks per second of audio.
 *
 * A fixed count regardless of length would make a 3-second clip and a
 * 3-minute one render at wildly different time resolutions; a per-second rate
 * keeps the visual density of a scrubber constant until the cap bites. 20/s
 * puts a syllable at roughly one peak, which is the detail a voice waveform
 * actually carries — beyond that the envelope is just noise.
 */
export const PEAKS_PER_SECOND = 20;

/** Anything shorter than one peak still gets one, so a clip is never empty. */
export const MIN_PEAKS = 1;

/**
 * How many peaks to emit for a clip of this length.
 *
 * Saturates at `MAX_PEAKS` past 50 seconds — the schema bound, not a choice.
 * Longer clips therefore get coarser peaks, which is the correct trade: the
 * strip is a fixed width on screen either way.
 */
export function targetPeakCount(durationMs: number): number {
    if (!(durationMs > 0)) return MIN_PEAKS;
    const wanted = Math.round((durationMs / 1000) * PEAKS_PER_SECOND);
    return Math.min(MAX_PEAKS, Math.max(MIN_PEAKS, wanted));
}

/**
 * Reduce mono 16-bit PCM to `count` peaks, normalized 0–100.
 *
 * **Normalized against the loudest sample in the clip, not against full
 * scale.** A quiet recording measured against full scale renders as a flat
 * line hugging zero — technically honest, visually useless, and this is a
 * rendering hint rather than a measurement. The trade is that peaks carry
 * shape but not absolute loudness, so they are not comparable between posts.
 *
 * Each bucket takes the MAX absolute sample in its span, not the mean. A mean
 * averages transients away and yields a limp envelope that understates
 * everything percussive; max is what audio editors draw.
 */
export function computePeaks(samples: Int16Array, count: number): number[] {
    if (samples.length === 0 || count <= 0) return [];

    const buckets = Math.min(count, samples.length);
    const peaks: number[] = new Array(buckets);
    let loudest = 0;

    for (let i = 0; i < buckets; i += 1) {
        // Bounds derived from the bucket index rather than accumulated, so
        // rounding cannot drift and leave the last bucket short or past the end.
        const start = Math.floor((i * samples.length) / buckets);
        const end = Math.floor(((i + 1) * samples.length) / buckets);
        let max = 0;
        for (let j = start; j < end; j += 1) {
            // `-32768` has no positive counterpart in Int16, so negating it
            // overflows back to itself. Clamping keeps the ratio at exactly 1
            // instead of producing a negative magnitude that poisons `loudest`.
            const magnitude = Math.min(Math.abs(samples[j]!), 32767);
            if (magnitude > max) max = magnitude;
        }
        peaks[i] = max;
        if (max > loudest) loudest = max;
    }

    // Digital silence: every peak is 0 and there is nothing to normalize
    // against. Emitting zeros is right — a flat line IS the shape of silence —
    // but dividing by the max is not, so this case exits before that.
    if (loudest === 0) return peaks.fill(0);

    return peaks.map((peak) => Math.round((peak / loudest) * 100));
}
