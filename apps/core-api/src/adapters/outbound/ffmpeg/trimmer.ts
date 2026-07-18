import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';
import {
    computeTrimWindow,
    parseDurationMs,
    parseSilences,
    MIN_SILENCE_MS,
    NOISE_FLOOR_DB,
} from '../../../lib/silence-trim.js';
import { runFfmpeg } from './run.js';

/**
 * ffmpeg-backed `TrimmerPort` — the first local-compute stage.
 *
 * Two passes, both over the bytes already in memory:
 *   1. `silencedetect` to find the head and tail silence (no output written).
 *   2. cut to the computed window and re-encode.
 *
 * **The re-encode is not incidental.** Voice Isolator returns 320 kbps CBR MP3
 * whatever it is given, inflating storage ~2.5x per denoised post permanently.
 * This stage already has to decode in order to detect silence, so undoing that
 * here costs one extra encode rather than a whole new dependency — which is
 * why step 3 deferred it to step 5 rather than solving it at the denoiser.
 *
 * Output is **Opus in WebM, 48 kbps mono**. Opus is the best voice codec at
 * this bitrate by a wide margin, and WebM/Opus is what browsers record in, so
 * it is already proven to play in this product's clients.
 */

export const OUTPUT_MIME = 'audio/webm';

export const ffmpegTrimmer: TrimmerPort = {
    async trim(input) {
        // Pass 1 — detect. `-f null -` decodes without writing an output file.
        const detect = await runFfmpeg(
            [
                '-hide_banner',
                '-i', 'pipe:0',
                '-af', `silencedetect=noise=${NOISE_FLOOR_DB}dB:d=${MIN_SILENCE_MS / 1000}`,
                '-f', 'null',
                '-',
            ],
            input.bytes,
        );

        const durationMs = parseDurationMs(detect.stderr);
        if (durationMs === null) {
            // Guessing here would silently mis-cut: the trailing-silence rule
            // is relative to the total, so a wrong duration removes real audio.
            throw new Error('ffmpeg reported no duration for the input');
        }

        const window = computeTrimWindow(durationMs, parseSilences(detect.stderr));

        // Nothing to cut, and already in the target format — which is exactly
        // what a re-run of an already-trimmed variant looks like. Re-encoding
        // here would be Opus→Opus for no gain, losing a generation every time
        // trim is re-requested. Pass the bytes through instead.
        //
        // A denoised variant reaches this point as 320kbps MP3, so it does NOT
        // match and still gets the re-encode that undoes the inflation.
        const nothingToCut = window.startMs === 0 && window.endMs === durationMs;
        if (nothingToCut && input.mimeType === OUTPUT_MIME) {
            return { bytes: input.bytes, mimeType: input.mimeType, durationMs: Math.round(durationMs) };
        }

        // Pass 2 — cut and re-encode. `-ss` before `-i` would seek the
        // container, which is not possible on a pipe, so it follows the input
        // and ffmpeg decodes-and-discards to the start point.
        //
        // `-t` (duration) rather than `-to` (stop position): with an
        // output-side `-ss`, whether `-to` measures from the input timeline or
        // the seek point has varied across ffmpeg versions, and
        // ANTIPHONY_FFMPEG_PATH allows a different one. A duration means the
        // same thing everywhere.
        const cut = await runFfmpeg(
            [
                '-hide_banner',
                '-i', 'pipe:0',
                '-ss', String(window.startMs / 1000),
                '-t', String((window.endMs - window.startMs) / 1000),
                '-ac', '1',
                '-c:a', 'libopus',
                '-b:a', '48k',
                '-f', 'webm',
                'pipe:1',
            ],
            input.bytes,
        );

        if (cut.stdout.length === 0) {
            // A zero-length result would be content-addressed and stored as a
            // valid-looking empty blob, replacing playable audio with nothing.
            // Same trap the denoiser adapter guards against.
            throw new Error('ffmpeg produced an empty trimmed variant');
        }

        // Read the duration back off the ENCODED bytes rather than trusting the
        // requested window. Opus frames are 20ms, so a window that is not a
        // frame multiple lands a frame away from what was asked for — and this
        // value becomes `processedDurationMs`, which step 7 serves to clients
        // as the post's duration.
        //
        // A third pass, but on the encoded output (tens of KB, not the input),
        // and the only source that is actually authoritative: the cut pass
        // writes to a pipe, so it never reports a container duration, and its
        // `time=` progress counter stops short of the true end — measured at
        // 3290ms for a file both the container header and a full decode agree
        // is 3300ms.
        const probe = await runFfmpeg(['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], cut.stdout);
        const measuredMs = parseDurationMs(probe.stderr);

        return {
            bytes: new Uint8Array(cut.stdout),
            mimeType: OUTPUT_MIME,
            // Fall back to the window if the probe cannot read it: a duration
            // off by a frame beats failing a stage that already produced good
            // audio.
            durationMs: Math.round(measuredMs ?? window.endMs - window.startMs),
        };
    },
};
