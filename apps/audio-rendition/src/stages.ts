import {
    computeTrimWindow,
    parseDurationMs,
    parseSilences,
    MIN_SILENCE_MS,
    NOISE_FLOOR_DB,
} from './lib/silence-trim.js';
import { computePeaks, targetPeakCount } from './lib/waveform-peaks.js';
import { runFfmpeg } from './lib/ffmpeg.js';

/**
 * The two INGEST stages — `trim` and `waveform`.
 *
 * ## Two jobs, one binary
 *
 * This service now serves both halves of the ffmpeg consolidation
 * (specs/archive/cloudflare-migration.md § The service already exists):
 *
 *   - **Delivery / rendition** (`rendition.ts`) — on-demand, read-path, cached
 *     by derived path, output format chosen by the requester.
 *   - **Ingest enrichment** (this file) — once per post, queue-driven,
 *     write-path, mutating the canonical bytes.
 *
 * They share a binary and nothing else. Note the shapes differ deliberately:
 * rendition takes `{originAppId, cid}` and talks to R2 at both ends, while these
 * take BYTES and give bytes or numbers back. That is not an inconsistency — see
 * § Why these take bytes in `app.ts`.
 *
 * ## Ported unchanged in behaviour
 *
 * Both implementations came from `apps/core-api/src/adapters/outbound/ffmpeg/`,
 * where they ran in-process while core-api was a Node service. The ffmpeg
 * invocations, the silence policy, and the peak computation are byte-identical
 * to the versions that served production — this move is about where the code
 * runs, not what it does. `TrimmerPort` and `WaveformPort` in `@antiphony/core`
 * are untouched; only their adapters changed from an `execFile` to a `fetch`.
 */

/**
 * Trim output is **Opus in WebM, 48 kbps mono**.
 *
 * The re-encode is not incidental. Voice Isolator returns 320 kbps CBR MP3
 * whatever it is given, inflating storage ~2.5x per denoised post permanently.
 * This stage already has to decode in order to detect silence, so undoing that
 * here costs one extra encode rather than a whole new dependency. Opus is the
 * best voice codec at this bitrate by a wide margin, and WebM/Opus is what
 * browsers record in, so it is already proven to play in this product's clients.
 */
export const TRIM_OUTPUT_MIME = 'audio/webm';

export interface TrimOutcome {
    bytes: Buffer;
    mimeType: string;
    durationMs: number;
}

/**
 * Trim leading and trailing silence, and re-encode.
 *
 * Interior gaps are left alone — they are often deliberate (a pause for effect,
 * a breath between clauses), and an aggressive interior cut is not recoverable
 * from the variant. Threshold and pad are `lib/silence-trim.ts`'s, deliberately
 * not part of any contract so tuning them is not a contract change.
 */
export async function trim(bytes: Uint8Array, mimeType: string): Promise<TrimOutcome> {
    // Pass 1 — detect. `-f null -` decodes without writing an output file.
    const detect = await runFfmpeg(
        [
            '-hide_banner',
            '-i', 'pipe:0',
            '-af', `silencedetect=noise=${NOISE_FLOOR_DB}dB:d=${MIN_SILENCE_MS / 1000}`,
            '-f', 'null',
            '-',
        ],
        bytes,
    );

    const durationMs = parseDurationMs(detect.stderr);
    if (durationMs === null) {
        // Guessing here would silently mis-cut: the trailing-silence rule is
        // relative to the total, so a wrong duration removes real audio.
        throw new Error('ffmpeg reported no duration for the input');
    }

    const window = computeTrimWindow(durationMs, parseSilences(detect.stderr));

    // Nothing to cut, and already in the target format — which is exactly what
    // a re-run of an already-trimmed variant looks like. Re-encoding here would
    // be Opus→Opus for no gain, losing a generation every time trim is
    // re-requested. Pass the bytes through instead.
    //
    // A denoised variant reaches this point as 320kbps MP3, so it does NOT match
    // and still gets the re-encode that undoes the inflation.
    const nothingToCut = window.startMs === 0 && window.endMs === durationMs;
    if (nothingToCut && mimeType === TRIM_OUTPUT_MIME) {
        return { bytes: Buffer.from(bytes), mimeType, durationMs: Math.round(durationMs) };
    }

    // Pass 2 — cut and re-encode. `-ss` before `-i` would seek the container,
    // which is not possible on a pipe, so it follows the input and ffmpeg
    // decodes-and-discards to the start point.
    //
    // `-t` (duration) rather than `-to` (stop position): with an output-side
    // `-ss`, whether `-to` measures from the input timeline or the seek point
    // has varied across ffmpeg versions, and `ANTIPHONY_FFMPEG_PATH` allows a
    // different one. A duration means the same thing everywhere.
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
        bytes,
    );

    if (cut.stdout.length === 0) {
        // A zero-length result would be content-addressed and stored as a
        // valid-looking empty blob, replacing playable audio with nothing.
        throw new Error('ffmpeg produced an empty trimmed variant');
    }

    // Read the duration back off the ENCODED bytes rather than trusting the
    // requested window. Opus frames are 20ms, so a window that is not a frame
    // multiple lands a frame away from what was asked for — and this value
    // becomes `processedDurationMs`, which the read view serves to clients as
    // the post's duration.
    //
    // A third pass, but on the encoded output (tens of KB, not the input), and
    // the only source that is actually authoritative: the cut pass writes to a
    // pipe, so it never reports a container duration, and its `time=` progress
    // counter stops short of the true end — measured at 3290ms for a file both
    // the container header and a full decode agree is 3300ms.
    const probe = await runFfmpeg(['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], cut.stdout);
    const measuredMs = parseDurationMs(probe.stderr);

    return {
        bytes: cut.stdout,
        mimeType: TRIM_OUTPUT_MIME,
        // Fall back to the window if the probe cannot read it: a duration off by
        // a frame beats failing a stage that already produced good audio.
        durationMs: Math.round(measuredMs ?? window.endMs - window.startMs),
    };
}

/**
 * Decode rate for the waveform. Far below anything you would listen to,
 * deliberately: this produces a ~40-pixel-tall envelope, not audio. 8 kHz still
 * carries every syllable boundary a waveform strip can show, and keeps a
 * 10-minute clip under 10 MB of PCM instead of ~50 MB at 48 kHz.
 */
const SAMPLE_RATE = 8000;

const BYTES_PER_SAMPLE = 2;

/**
 * Compute render-ready waveform peaks.
 *
 * One pass: decode straight to raw mono PCM and reduce it to an envelope. No
 * container is written, so unlike trim there is nothing to probe afterwards —
 * the sample count IS the duration, exactly, which is also why this never parses
 * ffmpeg's stderr for one.
 */
export async function waveform(bytes: Uint8Array): Promise<{ peaks: number[] }> {
    // `-f s16le` emits headerless little-endian 16-bit PCM, so stdout is the
    // sample array with no container to parse off the front.
    const decoded = await runFfmpeg(
        [
            '-hide_banner',
            '-i', 'pipe:0',
            '-ac', '1',
            '-ar', String(SAMPLE_RATE),
            '-f', 's16le',
            'pipe:1',
        ],
        bytes,
    );

    if (decoded.stdout.length < BYTES_PER_SAMPLE) {
        // ffmpeg exited 0 but decoded nothing — a container it could open but
        // whose audio stream is empty or unsupported. Emitting an empty peaks
        // array would settle the stage `ready` over a waveform that renders as
        // nothing, so fail instead and leave whatever the client supplied.
        throw new Error('ffmpeg decoded no audio for the waveform');
    }

    // A Buffer from a pipe is not guaranteed to sit at an even offset in its
    // backing ArrayBuffer, and Int16Array demands 2-byte alignment — an odd
    // offset throws. Copy in that case rather than assume; the common path is
    // already aligned and views in place.
    //
    // `new Uint8Array(buf)` rather than `Buffer.from(buf)`: both copy, but
    // Buffer's copy lands in Node's shared pool at whatever offset the allocator
    // picks, which is even only because the pool aligns to 8 bytes — an
    // implementation detail, not a promise. The typed-array constructor is
    // spec-guaranteed to produce a fresh ArrayBuffer at byteOffset 0.
    const aligned =
        decoded.stdout.byteOffset % BYTES_PER_SAMPLE === 0
            ? decoded.stdout
            : new Uint8Array(decoded.stdout);

    // Floor the length: a final odd byte is a truncated sample, and including it
    // would read one byte past the PCM into whatever follows.
    const sampleCount = Math.floor(aligned.length / BYTES_PER_SAMPLE);
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, sampleCount);

    const durationMs = (sampleCount / SAMPLE_RATE) * 1000;
    return { peaks: computePeaks(samples, targetPeakCount(durationMs)) };
}
