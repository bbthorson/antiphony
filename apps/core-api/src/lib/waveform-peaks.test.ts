import { describe, it, expect } from 'vitest';
import {
    computePeaks,
    targetPeakCount,
    MAX_PEAKS,
    MIN_PEAKS,
    PEAKS_PER_SECOND,
} from './waveform-peaks.js';

/**
 * Unit tests for the waveform envelope policy — pure arithmetic, no ffmpeg.
 * The adapter owns spawning; this owns deciding, and this is the deciding.
 */

describe('targetPeakCount', () => {
    it('scales with duration at the configured rate', () => {
        expect(targetPeakCount(5000)).toBe(5 * PEAKS_PER_SECOND);
    });

    it('saturates at the schema bound for long clips', () => {
        // `embed.waveform` is `.max(1000)`, so exceeding this would produce
        // peaks that fail validation on the way into the state.
        expect(targetPeakCount(60 * 60 * 1000)).toBe(MAX_PEAKS);
    });

    it('still emits a peak for a clip shorter than one', () => {
        expect(targetPeakCount(1)).toBe(MIN_PEAKS);
    });

    it('does not divide by a zero or negative duration', () => {
        expect(targetPeakCount(0)).toBe(MIN_PEAKS);
        expect(targetPeakCount(-1)).toBe(MIN_PEAKS);
    });
});

describe('computePeaks', () => {
    it('normalizes against the loudest sample, not full scale', () => {
        // A quiet clip: nothing near full scale. Measured against 32767 these
        // would all round to 0 and render as a flat line.
        const samples = Int16Array.from([100, 200, 300, 400]);
        expect(computePeaks(samples, 4)).toEqual([25, 50, 75, 100]);
    });

    it('takes the max of each bucket, not the mean', () => {
        // A transient in an otherwise quiet bucket must survive; a mean would
        // average it down to nothing.
        const samples = Int16Array.from([0, 0, 0, 1000, 500, 500, 500, 500]);
        expect(computePeaks(samples, 2)).toEqual([100, 50]);
    });

    it('treats a negative excursion as equal in magnitude', () => {
        const samples = Int16Array.from([-1000, 500]);
        expect(computePeaks(samples, 2)).toEqual([100, 50]);
    });

    it('clamps the Int16 floor instead of overflowing on negation', () => {
        // `Math.abs(-32768)` is 32768, one past Int16's positive range. Without
        // the clamp this still works by luck here, but a bucket holding only
        // -32768 would set `loudest` above any achievable peak and scale every
        // other bucket down. Assert the floor reads as full scale.
        const samples = Int16Array.from([-32768, 32767]);
        expect(computePeaks(samples, 2)).toEqual([100, 100]);
    });

    it('returns all zeros for digital silence rather than dividing by it', () => {
        const samples = new Int16Array(100);
        const peaks = computePeaks(samples, 10);
        expect(peaks).toHaveLength(10);
        expect(peaks.every((p) => p === 0)).toBe(true);
    });

    it('never emits more peaks than there are samples', () => {
        // Asking for 100 peaks from 3 samples must not pad with empty buckets:
        // a zero-width bucket has no max, and would render as a gap in audio
        // that has none.
        expect(computePeaks(Int16Array.from([1, 2, 3]), 100)).toHaveLength(3);
    });

    it('covers every sample, with no bucket left short by rounding', () => {
        // 10 samples into 3 buckets does not divide evenly. The loudest sample
        // sits last, so it is only reachable if the final bucket runs to the
        // end rather than stopping at an accumulated offset.
        const samples = Int16Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 100]);
        expect(computePeaks(samples, 3).at(-1)).toBe(100);
    });

    it('stays within the schema bounds for arbitrary input', () => {
        const samples = Int16Array.from({ length: 5000 }, (_, i) =>
            Math.round(Math.sin(i / 7) * 32767),
        );
        const peaks = computePeaks(samples, targetPeakCount(60_000));
        expect(peaks.length).toBeLessThanOrEqual(MAX_PEAKS);
        expect(peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 100)).toBe(true);
    });

    it('returns nothing for empty input', () => {
        expect(computePeaks(new Int16Array(0), 10)).toEqual([]);
    });
});
