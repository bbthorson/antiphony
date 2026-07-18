import { execFile } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { TrimmerPort } from '@antiphony/core/ports/audio-trimmer';
import {
    computeTrimWindow,
    parseDurationMs,
    parseSilences,
    MIN_SILENCE_MS,
    NOISE_FLOOR_DB,
} from '../../../lib/silence-trim.js';

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

const DEFAULT_TIMEOUT_MS = 120_000;
/** Enough headroom for a 100 MB lexicon-cap upload decoded to PCM. */
const MAX_BUFFER = 512 * 1024 * 1024;

export const OUTPUT_MIME = 'audio/webm';

/**
 * Whether an ffmpeg binary is resolvable, checked when providers are wired.
 *
 * Without this the trim capability would advertise `true` on a platform
 * `ffmpeg-static` has no build for, then fail every post at run time. A
 * capability that lies is worse than one that is absent: the stage settles
 * `failed` per post instead of an honest `skipped`.
 */
export function ffmpegAvailable(): boolean {
    return !!(process.env.ANTIPHONY_FFMPEG_PATH || ffmpegStatic);
}

function ffmpegPath(): string {
    // Overridable so a deployment can point at a system ffmpeg instead of
    // shipping the bundled binary.
    const configured = process.env.ANTIPHONY_FFMPEG_PATH;
    if (configured) return configured;
    if (!ffmpegStatic) throw new Error('ffmpeg binary not available');
    return ffmpegStatic;
}

/** Run ffmpeg with `bytes` on stdin, resolving stdout and stderr as buffers. */
function runFfmpeg(args: string[], bytes: Uint8Array): Promise<{ stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            ffmpegPath(),
            args,
            { encoding: 'buffer', maxBuffer: MAX_BUFFER, timeout: DEFAULT_TIMEOUT_MS },
            (error, stdout, stderr) => {
                // ffmpeg writes everything informational to stderr, so a
                // non-zero exit is the only reliable failure signal.
                if (error) {
                    reject(new Error(`ffmpeg failed: ${stderr.toString().slice(-500)}`));
                    return;
                }
                resolve({ stdout, stderr: stderr.toString() });
            },
        );
        child.stdin?.on('error', () => {
            // ffmpeg can exit before consuming all input (bad container, for
            // one). Without this handler the EPIPE is an unhandled error event
            // and takes the process down rather than failing the stage.
        });
        child.stdin?.end(bytes);
    });
}

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

        // Pass 2 — cut and re-encode. `-ss`/`-to` before `-i` would seek the
        // container, which is not possible on a pipe, so they follow the input
        // and ffmpeg decodes-and-discards to the start point.
        const cut = await runFfmpeg(
            [
                '-hide_banner',
                '-i', 'pipe:0',
                '-ss', String(window.startMs / 1000),
                '-to', String(window.endMs / 1000),
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

        return {
            bytes: new Uint8Array(cut.stdout),
            mimeType: OUTPUT_MIME,
            durationMs: Math.round(window.endMs - window.startMs),
        };
    },
};
