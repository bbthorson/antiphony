import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { resolveInitialProcessing, hasPendingStage, processingCapabilities } from './audio-processing.js';

/**
 * Unit tests for the processing composition seam — the pure capability
 * resolution + initial-state logic (no I/O). Env-driven, so each test sets
 * the flags it needs explicitly.
 *
 * `ELEVENLABS_API_KEY` is cleared around every test, not just after: a real
 * key in the developer's shell would otherwise make capabilities report
 * `transcribe: true` and flip these assertions depending on whose machine
 * they run on. Provider selection is env-driven, so env is test state.
 */

const PROVIDER_ENV = ['ANTIPHONY_PROCESSING_STUB', 'ELEVENLABS_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of PROVIDER_ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of PROVIDER_ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe('processingCapabilities', () => {
    it('reports both local stages with no API key configured', () => {
        // Trim and waveform are local compute, so they need no key — they are
        // available on their binary alone. Trim is what makes a variant change
        // possible with no transcriber present, the condition the recompute
        // filter handles; waveform is what it recomputes.
        expect(processingCapabilities()).toEqual({
            transcribe: false,
            denoise: false,
            trim: true,
            waveform: true,
        });
    });

    it('reports every stage available when the stubs are wired', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(processingCapabilities()).toEqual({
            transcribe: true,
            denoise: true,
            trim: true,
            waveform: true,
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
            reprocess: true,
        });
    });

    it('marks requested stages skipped when no provider is configured', () => {
        expect(resolveInitialProcessing({ transcribe: true, denoise: true })).toEqual({
            transcribe: 'skipped',
            denoise: 'skipped',
            reprocess: true,
        });
    });

    it('only includes the stages the app actually requested', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing({ transcribe: true })).toEqual({
            transcribe: 'pending',
            reprocess: true,
        });
    });

    it('carries an explicit reprocess opt-out through to the stored state', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing({ denoise: true, reprocess: false })?.reprocess).toBe(false);
    });

    it('writes reprocess on every request, so a later one is not governed by an earlier opt-out', () => {
        // `setProcessing` MERGES onto the stored state. Omitting the default
        // would leave a previous `reprocess: false` in place for a request
        // that never asked to opt out.
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing({ denoise: true })?.reprocess).toBe(true);
    });

    it('does not treat reprocess alone as a request for work', () => {
        // It names no stage, so there is nothing to run.
        expect(resolveInitialProcessing({ reprocess: true })).toBeUndefined();
        expect(resolveInitialProcessing({ reprocess: false })).toBeUndefined();
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
