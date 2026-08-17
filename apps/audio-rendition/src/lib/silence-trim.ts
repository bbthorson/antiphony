/**
 * Trim-window arithmetic for the ffmpeg trimmer, kept separate from the
 * subprocess so the policy is testable without the binary.
 *
 * Everything here is pure: ffmpeg's `silencedetect` output goes in, a cut
 * window comes out. The adapter owns spawning; this owns deciding.
 */

/** One silence interval reported by `silencedetect`. `endMs` absent ⇒ runs to EOF. */
export interface SilenceInterval {
    startMs: number;
    endMs?: number;
}

export interface TrimWindow {
    startMs: number;
    endMs: number;
}

/**
 * Padding kept on each side of the detected speech, in ms.
 *
 * Cutting to the exact onset clips plosives — a word starting with /p/ or /t/
 * has a burst that `silencedetect` scores as part of the silence, so trimming
 * to the reported boundary eats the consonant and the result sounds truncated.
 * Leaving a beat is the cheaper error.
 */
export const PAD_MS = 150;

/**
 * Silence shorter than this is not a gap worth trimming — it is the natural
 * pause between clauses. Only relevant at the head and tail, since interior
 * gaps are never cut.
 */
export const MIN_SILENCE_MS = 300;

/** Below this, audio counts as silence. Conservative: real rooms are not -60dB. */
export const NOISE_FLOOR_DB = -40;

/**
 * Shortest window worth emitting. Below this the result is padding and nothing
 * else, which means no speech was found at all.
 */
export const MIN_KEEP_MS = 2 * PAD_MS;

/**
 * Compute the cut window from detected silence.
 *
 * Leading and trailing only, by design — interior gaps are often deliberate
 * (a pause for effect, a breath) and cutting them is not recoverable from the
 * variant.
 *
 * Returns the full span when there is nothing to trim. The caller re-encodes
 * regardless, because undoing the denoiser's 320 kbps inflation is the other
 * half of this stage's job.
 */
export function computeTrimWindow(durationMs: number, silences: SilenceInterval[]): TrimWindow {
    if (!(durationMs > 0)) return { startMs: 0, endMs: 0 };

    let startMs = 0;
    let endMs = durationMs;

    // Leading: a silence interval that begins at (or effectively at) the head.
    // `silencedetect` reports the first as starting at 0; allow a hair of slop
    // so a detector that reports 0.004 is still treated as leading.
    const leading = silences.find((s) => s.startMs <= 10 && s.endMs !== undefined);
    if (leading?.endMs !== undefined && leading.endMs >= MIN_SILENCE_MS) {
        startMs = leading.endMs - PAD_MS;
    }

    // Trailing: either an interval with no end (silence ran to EOF) or one that
    // ends at the tail. The open-ended form is the common one — ffmpeg emits a
    // `silence_start` with no matching `silence_end` when the file ends quiet.
    const trailing = [...silences]
        .reverse()
        .find((s) => s.endMs === undefined || s.endMs >= durationMs - 10);
    if (trailing && durationMs - trailing.startMs >= MIN_SILENCE_MS) {
        endMs = trailing.startMs + PAD_MS;
    }

    // Clamp to the media before checking collapse, so a pad that overshoots
    // either edge cannot widen the window past the source.
    startMs = Math.max(0, Math.min(startMs, durationMs));
    endMs = Math.max(0, Math.min(endMs, durationMs));

    // A window this short is all padding and no speech — the end-to-end silent
    // recording, where the tail rule fires from 0 and the head rule never does.
    // Emitting it would store a near-empty blob in place of the audio:
    // content-addressed, valid-looking, and silent. Keep the whole thing.
    //
    // Note this cannot catch an inverted window, because there is no such
    // thing: silences are ordered and non-overlapping, so a padded window is
    // always at least `2 * PAD_MS` wide.
    if (endMs - startMs < MIN_KEEP_MS) return { startMs: 0, endMs: durationMs };

    return { startMs, endMs };
}

/**
 * Parse `silencedetect` output off ffmpeg's stderr.
 *
 * Lines look like:
 *   [silencedetect @ 0x…] silence_start: 0
 *   [silencedetect @ 0x…] silence_end: 1.234 | silence_duration: 1.234
 *
 * A `silence_start` with no following `silence_end` means the file ends in
 * silence, which is preserved here as an interval with no `endMs`.
 */
export function parseSilences(stderr: string): SilenceInterval[] {
    const out: SilenceInterval[] = [];
    for (const line of stderr.split('\n')) {
        const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (start?.[1] !== undefined) {
            out.push({ startMs: Math.max(0, Number(start[1]) * 1000) });
            continue;
        }
        const end = /silence_end:\s*([\d.]+)/.exec(line);
        // Attach to the open interval; a stray end with no start is ignored
        // rather than trusted, since it would imply a malformed stream.
        if (end?.[1] !== undefined && out.length > 0 && out[out.length - 1]!.endMs === undefined) {
            out[out.length - 1]!.endMs = Number(end[1]) * 1000;
        }
    }
    return out;
}

/**
 * Total duration in ms from ffmpeg stderr.
 *
 * Prefers the `Duration:` header, but piped input often reports `N/A` because
 * the container header is not seekable, so the last `time=` progress line is
 * the fallback. Returns null when neither is present — the caller must fail the
 * stage rather than guess, since a wrong duration silently mis-cuts the audio.
 */
export function parseDurationMs(stderr: string): number | null {
    const header = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (header) return hmsToMs(header[1]!, header[2]!, header[3]!);

    let last: RegExpExecArray | null = null;
    const progress = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g;
    for (let m = progress.exec(stderr); m !== null; m = progress.exec(stderr)) last = m;
    if (last) return hmsToMs(last[1]!, last[2]!, last[3]!);

    return null;
}

function hmsToMs(h: string, m: string, s: string): number {
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
}
