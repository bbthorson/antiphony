import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeWaveform } from './waveform';

/**
 * `computeWaveform` is the one piece of real arithmetic in this package, and
 * the only one whose output crosses the wire into a lexicon field with a
 * declared range (0–100 ints). That makes it the highest-value thing to test:
 * a normalization bug here is a validation failure at post-create time, far
 * from the code that caused it.
 *
 * jsdom has no Web Audio, so `AudioContext` is stubbed with a fake that decodes
 * to whatever samples the test hands it. The stub is the boundary — everything
 * inside `computeWaveform` is the real implementation.
 */

const close = vi.fn();

/** Install a fake AudioContext whose decode step yields `samples`. */
function stubAudioContext(samples: Float32Array) {
    class FakeAudioContext {
        close = close;
        async decodeAudioData() {
            return { getChannelData: () => samples } as unknown as AudioBuffer;
        }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
}

/** A Blob whose bytes never matter — the stub decodes to fixed samples. */
function fakeBlob(): Blob {
    return { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

afterEach(() => {
    vi.unstubAllGlobals();
    close.mockClear();
});

describe('computeWaveform', () => {
    it('returns exactly `buckets` peaks', async () => {
        stubAudioContext(new Float32Array(1000).fill(0.5));
        const peaks = await computeWaveform(fakeBlob(), 32);
        expect(peaks).toHaveLength(32);
    });

    it('normalizes the loudest bucket to 100', async () => {
        // Ramp: the last bucket is the loudest, whatever the absolute scale.
        const samples = Float32Array.from({ length: 640 }, (_, i) => i / 640);
        stubAudioContext(samples);

        const peaks = await computeWaveform(fakeBlob(), 64);

        expect(Math.max(...peaks)).toBe(100);
        expect(peaks[peaks.length - 1]).toBe(100);
    });

    it('emits integers within the lexicon range 0–100', async () => {
        const samples = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i) * 0.8);
        stubAudioContext(samples);

        const peaks = await computeWaveform(fakeBlob(), 64);

        for (const p of peaks) {
            expect(Number.isInteger(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(100);
        }
    });

    it('returns all zeros for silence instead of NaN', async () => {
        // The max=0 guard. Without it the scale is 100/0 = Infinity and every
        // peak serializes as null, which the lexicon rejects.
        stubAudioContext(new Float32Array(512));
        const peaks = await computeWaveform(fakeBlob(), 16);
        expect(peaks).toEqual(new Array(16).fill(0));
    });

    it('handles a clip shorter than the bucket count', async () => {
        // blockSize floors to 0 for a 4-sample clip in 64 buckets; the `|| 1`
        // fallback keeps it from dividing by zero.
        stubAudioContext(Float32Array.from([1, 0.5, 0.25, 0]));
        const peaks = await computeWaveform(fakeBlob(), 64);
        expect(peaks).toHaveLength(64);
        expect(peaks.every((p) => Number.isInteger(p))).toBe(true);
    });

    it('closes the AudioContext even when decoding throws', async () => {
        class ThrowingAudioContext {
            close = close;
            async decodeAudioData(): Promise<AudioBuffer> {
                throw new Error('corrupt');
            }
        }
        vi.stubGlobal('AudioContext', ThrowingAudioContext);

        await expect(computeWaveform(fakeBlob())).rejects.toThrow('corrupt');
        // The `finally` block. A leaked AudioContext is a real resource: browsers
        // cap them per page, so a few failed decodes can wedge later captures.
        expect(close).toHaveBeenCalledOnce();
    });
});
