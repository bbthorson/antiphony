import { describe, it, expect, afterEach, beforeEach } from 'vitest';
// The ffmpeg stage adapters are installed by the Node runtime, not imported by
// the registry — see native.ts. Without this the `trim`/`waveform`
// expectations below describe a Worker, where both stages are correctly
// unavailable.
import '../native.js';
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

/** A tenant with no per-tenant overrides — resolves the deployment default. */
const TENANT = 'vox-pop';

const PROVIDER_ENV = [
    'ANTIPHONY_PROCESSING_STUB',
    'ELEVENLABS_API_KEY',
    'ANTIPHONY_TRANSCRIBER',
    'ANTIPHONY_DENOISER',
    'ANTIPHONY_TRIMMER',
    'ANTIPHONY_WAVEFORM',
    'ANTIPHONY_APP_TRANSCRIBERS',
    'ANTIPHONY_APP_DENOISERS',
    'ANTIPHONY_APP_TRIMMERS',
    'ANTIPHONY_APP_WAVEFORMS',
    'ANTIPHONY_APP_STT_MODELS',
] as const;
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

    it('reproduces the pre-registry wiring when no stage names a provider', () => {
        // The regression gate for per-stage selection: no deployment sets the
        // new vars, so all of them must resolve exactly as the old single
        // `if (elevenLabsApiKey())` branch did.
        process.env.ELEVENLABS_API_KEY = 'test-key';
        expect(processingCapabilities()).toEqual({
            transcribe: true,
            denoise: true,
            trim: true,
            waveform: true,
        });
    });
});

describe('per-stage provider selection', () => {
    it('resolves each stage independently', () => {
        // The point of the registry: a real transcriber next to a stub
        // denoiser, which the old all-or-nothing key gate could not express.
        process.env.ELEVENLABS_API_KEY = 'test-key';
        process.env.ANTIPHONY_DENOISER = 'stub';
        process.env.ANTIPHONY_TRANSCRIBER = 'elevenlabs';
        const caps = processingCapabilities();
        expect(caps.transcribe).toBe(true);
        expect(caps.denoise).toBe(true);
    });

    it('never reaches a stub through the default scan', () => {
        // The safety property. A deployment that lost its key must report
        // `transcribe: false` — settling posts `skipped`, which the pipeline
        // handles — and must NOT quietly fall through to the stub, which would
        // save `[stub transcript]` as a real record against real posts.
        expect(processingCapabilities().transcribe).toBe(false);
        expect(processingCapabilities().denoise).toBe(false);
    });

    it('disables a stage whose named provider is not configured', () => {
        // Misconfiguration, not opt-out: the operator named ElevenLabs and has
        // no key. Logged, and the stage is honestly unavailable.
        process.env.ANTIPHONY_TRANSCRIBER = 'elevenlabs';
        expect(processingCapabilities().transcribe).toBe(false);
    });

    it('disables a stage named with an unknown provider rather than falling back', () => {
        // A key IS present, so the default scan would have found ElevenLabs.
        // Falling through would overrule the operator's explicit choice
        // silently — the failure mode this seam already rejects for dispatch.
        process.env.ELEVENLABS_API_KEY = 'test-key';
        process.env.ANTIPHONY_TRANSCRIBER = 'whisper';
        expect(processingCapabilities().transcribe).toBe(false);
    });

    it('matches a provider name case-insensitively', () => {
        process.env.ANTIPHONY_WAVEFORM = 'STUB';
        expect(processingCapabilities().waveform).toBe(true);
    });

    it('lets the wholesale stub flag override every per-stage name', () => {
        // `_STUB` still wins ahead of selection, so a dev shell that names a
        // real provider cannot bill one.
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        process.env.ANTIPHONY_TRANSCRIBER = 'elevenlabs';
        process.env.ANTIPHONY_DENOISER = 'whisper';
        expect(processingCapabilities()).toEqual({
            transcribe: true,
            denoise: true,
            trim: true,
            waveform: true,
        });
    });
});

describe('per-tenant provider selection', () => {
    it('gives a pinned tenant a different provider from its neighbours', () => {
        // The point of the tenant layer. No deployment default is set, and no
        // key, so `acme` would otherwise have no transcriber at all.
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:stub';
        expect(processingCapabilities('acme').transcribe).toBe(true);
        expect(processingCapabilities('vox-pop').transcribe).toBe(false);
    });

    it('takes the deployment default for a tenant with no pin', () => {
        process.env.ELEVENLABS_API_KEY = 'test-key';
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:stub';
        expect(processingCapabilities('vox-pop').transcribe).toBe(true);
    });

    it('lets a tenant pin override the deployment default', () => {
        // Narrowest layer wins: the deployment says elevenlabs (and has a key,
        // so that would resolve), the tenant says stub.
        process.env.ELEVENLABS_API_KEY = 'test-key';
        process.env.ANTIPHONY_TRANSCRIBER = 'elevenlabs';
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:stub';
        expect(processingCapabilities('acme').transcribe).toBe(true);
        expect(processingCapabilities('vox-pop').transcribe).toBe(true);
    });

    it('disables the stage for a tenant pinned to an unconfigured provider', () => {
        // Misconfiguration at the tenant layer behaves exactly as at the
        // deployment layer: logged, honestly unavailable, and NOT fallen back
        // — including not falling back to the deployment default, which would
        // silently overrule the pin.
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:elevenlabs';
        expect(processingCapabilities('acme').transcribe).toBe(false);
    });

    it('does not fall back to the deployment default for an unknown tenant pin', () => {
        process.env.ELEVENLABS_API_KEY = 'test-key';
        process.env.ANTIPHONY_TRANSCRIBER = 'elevenlabs';
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:whisper';
        expect(processingCapabilities('acme').transcribe).toBe(false);
        // The neighbour is untouched — one tenant's bad pin is not an outage.
        expect(processingCapabilities('vox-pop').transcribe).toBe(true);
    });

    it('ignores a malformed entry without dropping the rest of the var', () => {
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'noseparator,acme:stub';
        expect(processingCapabilities('acme').transcribe).toBe(true);
    });

    it('resolves the deployment wiring when no tenant is named', () => {
        // `resolveProviders()` with no app id skips the tenant layer entirely,
        // so a tenant pin cannot leak into a deployment-wide answer.
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:stub';
        expect(processingCapabilities().transcribe).toBe(false);
    });
});

describe('resolveInitialProcessing', () => {
    it('returns undefined when nothing is requested', () => {
        expect(resolveInitialProcessing(TENANT, undefined)).toBeUndefined();
        expect(resolveInitialProcessing(TENANT, {})).toBeUndefined();
        expect(resolveInitialProcessing(TENANT, { transcribe: false, denoise: false })).toBeUndefined();
    });

    it('marks requested stages pending when the deployment can do them', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing(TENANT, { transcribe: true, denoise: true })).toEqual({
            transcribe: 'pending',
            denoise: 'pending',
            reprocess: true,
        });
    });

    it('marks requested stages skipped when no provider is configured', () => {
        expect(resolveInitialProcessing(TENANT, { transcribe: true, denoise: true })).toEqual({
            transcribe: 'skipped',
            denoise: 'skipped',
            reprocess: true,
        });
    });

    it('only includes the stages the app actually requested', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing(TENANT, { transcribe: true })).toEqual({
            transcribe: 'pending',
            reprocess: true,
        });
    });

    it('carries an explicit reprocess opt-out through to the stored state', () => {
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing(TENANT, { denoise: true, reprocess: false })?.reprocess).toBe(false);
    });

    it('writes reprocess on every request, so a later one is not governed by an earlier opt-out', () => {
        // `setProcessing` MERGES onto the stored state. Omitting the default
        // would leave a previous `reprocess: false` in place for a request
        // that never asked to opt out.
        process.env.ANTIPHONY_PROCESSING_STUB = 'true';
        expect(resolveInitialProcessing(TENANT, { denoise: true })?.reprocess).toBe(true);
    });

    it('does not treat reprocess alone as a request for work', () => {
        // It names no stage, so there is nothing to run.
        expect(resolveInitialProcessing(TENANT, { reprocess: true })).toBeUndefined();
        expect(resolveInitialProcessing(TENANT, { reprocess: false })).toBeUndefined();
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
