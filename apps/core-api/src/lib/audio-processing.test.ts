import { describe, it, expect, afterEach } from 'vitest';
import { resolveInitialProcessing, hasPendingStage, processingCapabilities } from './audio-processing.js';

/**
 * Unit tests for the processing composition seam — the pure capability
 * resolution + initial-state logic (no I/O). Env-driven, so each test sets
 * ANTIPHONY_PROCESSING_STUB explicitly and clears it after.
 */

afterEach(() => {
    delete process.env.ANTIPHONY_PROCESSING_STUB;
});

describe('processingCapabilities', () => {
    it('reports nothing available with no providers configured', () => {
        expect(processingCapabilities()).toEqual({
            transcribe: false,
            denoise: false,
            trim: false,
            waveform: false,
        });
    });

    it('reports the provider-backed stages available when the stubs are wired', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        // `trim`/`waveform` stay false — they have no port yet (plan steps 5-6),
        // so requesting them resolves to `skipped` rather than hanging `pending`.
        expect(processingCapabilities()).toEqual({
            transcribe: true,
            denoise: true,
            trim: false,
            waveform: false,
        });
    });
});

describe('resolveInitialProcessing', () => {
    it('returns undefined when nothing is requested', () => {
        expect(resolveInitialProcessing(undefined)).toBeUndefined();
        expect(resolveInitialProcessing({})).toBeUndefined();
        expect(resolveInitialProcessing({ transcribe: false, denoise: false })).toBeUndefined();
    });

    it('marks requested stages pending when the deployment can do them', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing({ transcribe: true, denoise: true })).toEqual({
            transcribe: 'pending',
            denoise: 'pending',
        });
    });

    it('marks requested stages skipped when no provider is configured', () => {
        expect(resolveInitialProcessing({ transcribe: true, denoise: true })).toEqual({
            transcribe: 'skipped',
            denoise: 'skipped',
        });
    });

    it('only includes the stages the app actually requested', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing({ transcribe: true })).toEqual({ transcribe: 'pending' });
    });
});

describe('hasPendingStage', () => {
    it('is true only when some stage is pending', () => {
        expect(hasPendingStage(undefined)).toBe(false);
        expect(hasPendingStage({ transcribe: 'skipped', denoise: 'skipped' })).toBe(false);
        expect(hasPendingStage({ transcribe: 'ready' })).toBe(false);
        expect(hasPendingStage({ transcribe: 'pending' })).toBe(true);
        expect(hasPendingStage({ denoise: 'pending', transcribe: 'skipped' })).toBe(true);
    });
});
