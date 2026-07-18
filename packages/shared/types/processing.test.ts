import { describe, it, expect } from 'vitest';
import { resolveAudioVariant, type ProcessingState } from './processing';

/**
 * Tests for read-time variant resolution (plan step 7).
 *
 * The property under test throughout is that url, duration and peaks describe
 * the SAME audio. Asserting the fields individually would pass on exactly the
 * mixed states this function exists to rule out, so each case checks the trio.
 */

const CANONICAL = {
    blobCid: 'original-cid',
    durationMs: 5000,
    waveform: [10, 20, 30],
};

/** A stored state; `updatedAt` is required by the schema but irrelevant here. */
function state(patch: Partial<ProcessingState> = {}): ProcessingState {
    return { updatedAt: new Date(), ...patch } as ProcessingState;
}

describe('resolveAudioVariant', () => {
    it('returns the record untouched when no processing was requested', () => {
        expect(resolveAudioVariant(CANONICAL, undefined)).toEqual(CANONICAL);
    });

    it('returns the record untouched when processing ran but produced no variant', () => {
        // Transcribe-only: a derived stage completed, but no bytes changed, so
        // there is nothing to resolve to.
        const resolved = resolveAudioVariant(CANONICAL, state({ transcribe: 'ready' }));
        expect(resolved).toEqual(CANONICAL);
    });

    it('moves url, duration and peaks together for a fully-processed post', () => {
        // The step 7 "done when": every field describes the trimmed variant.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({
                trim: 'ready',
                waveform: 'ready',
                processedBlobCid: 'variant-cid',
                processedDurationMs: 3000,
                waveformPeaks: [90, 100],
            }),
        );
        expect(resolved).toEqual({
            blobCid: 'variant-cid',
            durationMs: 3000,
            waveform: [90, 100],
        });
    });

    it('keeps the original duration when the variant did not retime it', () => {
        // Denoise transcodes without changing length, so `processedDurationMs`
        // is absent and the record's duration still describes the variant. The
        // trio stays consistent BECAUSE of the fallback, not despite it.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({ denoise: 'ready', processedBlobCid: 'variant-cid' }),
        );
        expect(resolved.blobCid).toBe('variant-cid');
        expect(resolved.durationMs).toBe(5000);
    });

    it('does not serve peaks from a superseded variant while recompute is pending', () => {
        // The regression this gate exists for: a byte-mutating stage completing
        // sets waveform back to `pending` WITHOUT clearing `waveformPeaks`, so
        // the field still holds peaks for the previous variant. Serving them
        // would draw the old envelope across the new duration.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({
                trim: 'ready',
                waveform: 'pending',
                processedBlobCid: 'variant-cid',
                processedDurationMs: 3000,
                waveformPeaks: [90, 100],
            }),
        );
        expect(resolved.waveform).toEqual([10, 20, 30]);
        expect(resolved.waveform).not.toEqual([90, 100]);
    });

    it('does not serve peaks from a failed waveform stage', () => {
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({ waveform: 'failed', processedBlobCid: 'variant-cid' }),
        );
        expect(resolved.waveform).toEqual([10, 20, 30]);
    });

    it('serves computed peaks for a waveform-only post, with no variant', () => {
        // waveform always runs over the final variant — here that IS the
        // original — so `ready` peaks describe what playback resolves to.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({ waveform: 'ready', waveformPeaks: [1, 2, 3] }),
        );
        expect(resolved.blobCid).toBe('original-cid');
        expect(resolved.durationMs).toBe(5000);
        expect(resolved.waveform).toEqual([1, 2, 3]);
    });

    it('carries absent canonical fields through as absent', () => {
        // `durationMs` and `waveform` are both optional on the record; a client
        // that supplied neither must not gain an `undefined`-valued key.
        const resolved = resolveAudioVariant({ blobCid: 'only-cid' }, undefined);
        expect(resolved.durationMs).toBeUndefined();
        expect(resolved.waveform).toBeUndefined();
    });

    it('fills in a duration the record never had once trim measures one', () => {
        const resolved = resolveAudioVariant(
            { blobCid: 'only-cid' },
            state({ trim: 'ready', processedBlobCid: 'variant-cid', processedDurationMs: 2500 }),
        );
        expect(resolved.durationMs).toBe(2500);
    });

    it('treats a zero-length trim result as a real duration, not a missing one', () => {
        // `?? ` rather than `||` matters here: 0 is a legitimate measurement and
        // must not fall back to the original's 5000.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({ trim: 'ready', processedBlobCid: 'variant-cid', processedDurationMs: 0 }),
        );
        expect(resolved.durationMs).toBe(0);
    });

    it('serves an empty peaks array rather than falling back to the record', () => {
        // Digital silence legitimately reduces to no peaks. An empty array is a
        // result, not an absence.
        const resolved = resolveAudioVariant(
            CANONICAL,
            state({ waveform: 'ready', waveformPeaks: [] }),
        );
        expect(resolved.waveform).toEqual([]);
    });

    it('does not mutate its inputs', () => {
        const canonical = { ...CANONICAL, waveform: [10, 20, 30] };
        resolveAudioVariant(
            canonical,
            state({ waveform: 'ready', waveformPeaks: [5], processedBlobCid: 'v' }),
        );
        expect(canonical).toEqual(CANONICAL);
    });
});
