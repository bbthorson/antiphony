import type { WaveformPort } from '@antiphony/core/ports/audio-waveform';
import { computePeaks, targetPeakCount } from '../../../lib/waveform-peaks.js';
import { runFfmpeg } from './run.js';

/**
 * ffmpeg-backed `WaveformPort` — the second local-compute stage, and the only
 * derived stage that needs no API key.
 *
 * One pass: decode straight to raw mono PCM and reduce it to an envelope. No
 * container is written, so unlike the trimmer there is nothing to probe
 * afterwards — the sample count IS the duration, exactly, which is also why
 * this adapter never parses ffmpeg's stderr for one.
 */

/**
 * Decode rate. Far below anything you would listen to, deliberately: this
 * produces a ~40-pixel-tall envelope, not audio. 8 kHz still carries every
 * syllable boundary a waveform strip can show, and keeps a 10-minute clip
 * under 10 MB of PCM instead of ~50 MB at 48 kHz.
 */
const SAMPLE_RATE = 8000;

const BYTES_PER_SAMPLE = 2;

export const ffmpegWaveform: WaveformPort = {
    async waveform(input) {
        // `-f s16le` emits headerless little-endian 16-bit PCM, so stdout is
        // the sample array with no container to parse off the front.
        const decoded = await runFfmpeg(
            [
                '-hide_banner',
                '-i', 'pipe:0',
                '-ac', '1',
                '-ar', String(SAMPLE_RATE),
                '-f', 's16le',
                'pipe:1',
            ],
            input.bytes,
        );

        if (decoded.stdout.length < BYTES_PER_SAMPLE) {
            // ffmpeg exited 0 but decoded nothing — a container it could open
            // but whose audio stream is empty or unsupported. Emitting an empty
            // peaks array would settle the stage `ready` over a waveform that
            // renders as nothing, so fail the stage instead and leave whatever
            // the client supplied in place.
            throw new Error('ffmpeg decoded no audio for the waveform');
        }

        // A Buffer from a pipe is not guaranteed to sit at an even offset in
        // its backing ArrayBuffer, and Int16Array demands 2-byte alignment —
        // an odd offset throws. Copy in that case rather than assume; the
        // common path is already aligned and views in place.
        const aligned =
            decoded.stdout.byteOffset % BYTES_PER_SAMPLE === 0
                ? decoded.stdout
                : Buffer.from(decoded.stdout);

        // Floor the length: a final odd byte is a truncated sample, and
        // including it would read one byte past the PCM into whatever follows.
        const sampleCount = Math.floor(aligned.length / BYTES_PER_SAMPLE);
        const samples = new Int16Array(aligned.buffer, aligned.byteOffset, sampleCount);

        const durationMs = (sampleCount / SAMPLE_RATE) * 1000;
        return { peaks: computePeaks(samples, targetPeakCount(durationMs)) };
    },
};
