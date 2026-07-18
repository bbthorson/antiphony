import { describe, it, expect } from 'vitest';
import {
    computeTrimWindow,
    parseDurationMs,
    parseSilences,
    MIN_SILENCE_MS,
    PAD_MS,
} from './silence-trim.js';

describe('parseSilences', () => {
    it('pairs a start with its following end', () => {
        const out = parseSilences([
            '[silencedetect @ 0x1] silence_start: 0',
            '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5',
        ].join('\n'));
        expect(out).toEqual([{ startMs: 0, endMs: 1500 }]);
    });

    it('leaves a trailing silence open when the file ends quiet', () => {
        // ffmpeg emits no `silence_end` when silence runs to EOF. That absence
        // IS the signal for trailing silence, so it must survive parsing.
        const out = parseSilences([
            '[silencedetect @ 0x1] silence_start: 0',
            '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5',
            '[silencedetect @ 0x1] silence_start: 5.2',
        ].join('\n'));
        expect(out).toEqual([{ startMs: 0, endMs: 1500 }, { startMs: 5200 }]);
    });

    it('ignores an end with no open interval', () => {
        expect(parseSilences('[silencedetect @ 0x1] silence_end: 3.0')).toEqual([]);
    });

    it('clamps a negative start to zero', () => {
        expect(parseSilences('silence_start: -0.001')).toEqual([{ startMs: 0 }]);
    });

    it('returns nothing for output with no silence lines', () => {
        expect(parseSilences('frame= 100 fps=0.0 q=-1.0 size=  1kB')).toEqual([]);
    });
});

describe('parseDurationMs', () => {
    it('reads the Duration header', () => {
        expect(parseDurationMs('  Duration: 00:00:06.09, start: 0.000000')).toBeCloseTo(6090);
    });

    it('falls back to the last time= when Duration is N/A', () => {
        // The piped-input case: the container header is not seekable, so
        // ffmpeg cannot report a duration up front.
        const stderr = [
            '  Duration: N/A, start: 0.000000, bitrate: N/A',
            'size=N/A time=00:00:02.00 bitrate=N/A',
            'size=N/A time=00:00:06.09 bitrate=N/A',
        ].join('\n');
        expect(parseDurationMs(stderr)).toBeCloseTo(6090);
    });

    it('returns null when neither is present', () => {
        // The caller must fail the stage rather than guess — a wrong duration
        // mis-cuts the trailing edge and removes real audio.
        expect(parseDurationMs('ffmpeg version 6.0')).toBeNull();
    });

    it('handles durations past an hour', () => {
        expect(parseDurationMs('Duration: 01:02:03.50')).toBeCloseTo(3723500);
    });
});

describe('computeTrimWindow', () => {
    it('trims both edges, keeping the pad', () => {
        const w = computeTrimWindow(6000, [{ startMs: 0, endMs: 1500 }, { startMs: 5200 }]);
        expect(w).toEqual({ startMs: 1500 - PAD_MS, endMs: 5200 + PAD_MS });
    });

    it('keeps the full span when no silence was detected', () => {
        expect(computeTrimWindow(6000, [])).toEqual({ startMs: 0, endMs: 6000 });
    });

    it('ignores interior silence', () => {
        // The conservative policy: a mid-clip gap is often deliberate, and
        // cutting it is not recoverable from the variant.
        expect(computeTrimWindow(6000, [{ startMs: 2000, endMs: 3000 }]))
            .toEqual({ startMs: 0, endMs: 6000 });
    });

    it('ignores a leading gap shorter than the minimum', () => {
        const brief = MIN_SILENCE_MS - 50;
        expect(computeTrimWindow(6000, [{ startMs: 0, endMs: brief }]))
            .toEqual({ startMs: 0, endMs: 6000 });
    });

    it('treats a closed silence at the tail as trailing', () => {
        const w = computeTrimWindow(6000, [{ startMs: 4000, endMs: 6000 }]);
        expect(w).toEqual({ startMs: 0, endMs: 4000 + PAD_MS });
    });

    it('keeps the whole clip when it is silent end to end', () => {
        // The window collapses here. Emitting it would store an empty blob in
        // place of the audio — content-addressed, valid-looking, and silent.
        expect(computeTrimWindow(6000, [{ startMs: 0 }]))
            .toEqual({ startMs: 0, endMs: 6000 });
    });

    it('keeps a sliver of speech rather than discarding it', () => {
        // 20ms of speech between two silences. The pads dominate the result,
        // but the window is real and must not be thrown away — the collapse
        // guard exists for the no-speech case, not the little-speech case.
        expect(computeTrimWindow(3000, [{ startMs: 0, endMs: 1490 }, { startMs: 1510 }]))
            .toEqual({ startMs: 1490 - PAD_MS, endMs: 1510 + PAD_MS });
    });

    it('never widens the window past the source', () => {
        // A pad that overshoots the tail must clamp, not extend into audio
        // that does not exist.
        const w = computeTrimWindow(5300, [{ startMs: 0, endMs: 1000 }, { startMs: 5250 }]);
        expect(w.endMs).toBeLessThanOrEqual(5300);
        expect(w.startMs).toBeGreaterThanOrEqual(0);
    });

    it('returns an empty window for a zero-length input', () => {
        expect(computeTrimWindow(0, [])).toEqual({ startMs: 0, endMs: 0 });
    });
});
