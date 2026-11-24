import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    tenantProvider,
    tenantModel,
    tenantAssessSets,
    TENANT_PROVIDER_VARS,
    TENANT_MODEL_VARS,
    TENANT_ASSESS_SETS_VAR,
} from './tenant-provider-config.js';

const ALL_VARS = [
    ...Object.values(TENANT_PROVIDER_VARS),
    ...Object.values(TENANT_MODEL_VARS),
    TENANT_ASSESS_SETS_VAR,
];

function clearVars() {
    for (const v of ALL_VARS) delete process.env[v];
}

beforeEach(() => {
    process.env.LOG_LEVEL = 'silent';
    clearVars();
});

afterEach(() => {
    clearVars();
});

describe('tenantProvider', () => {
    it('returns undefined when the stage env var is unset or blank', () => {
        expect(tenantProvider('transcribe', 'voxpop')).toBeUndefined();
        process.env.ANTIPHONY_APP_TRANSCRIBERS = '   ';
        expect(tenantProvider('transcribe', 'voxpop')).toBeUndefined();
    });

    it('resolves per-tenant providers across all four stages', () => {
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'voxpop:elevenlabs, bardcast:workers-ai';
        process.env.ANTIPHONY_APP_DENOISERS = 'voxpop:elevenlabs';
        process.env.ANTIPHONY_APP_TRIMMERS = 'bardcast:rendition';
        process.env.ANTIPHONY_APP_WAVEFORMS = 'voxpop:stub';

        expect(tenantProvider('transcribe', 'voxpop')).toBe('elevenlabs');
        expect(tenantProvider('transcribe', 'bardcast')).toBe('workers-ai');
        expect(tenantProvider('transcribe', 'unknown')).toBeUndefined();
        expect(tenantProvider('denoise', 'voxpop')).toBe('elevenlabs');
        expect(tenantProvider('trim', 'bardcast')).toBe('rendition');
        expect(tenantProvider('waveform', 'voxpop')).toBe('stub');
    });

    it('ignores malformed entries without breaking valid sibling entries', () => {
        process.env.ANTIPHONY_APP_TRANSCRIBERS =
            'missing-colon, :no-app, no-value:, , voxpop:elevenlabs, bardcast:stub';

        expect(tenantProvider('transcribe', 'voxpop')).toBe('elevenlabs');
        expect(tenantProvider('transcribe', 'bardcast')).toBe('stub');
        expect(tenantProvider('transcribe', 'missing-colon')).toBeUndefined();
        expect(tenantProvider('transcribe', 'no-value')).toBeUndefined();
    });

    it('invalidates the cache when the raw env string changes', () => {
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'voxpop:elevenlabs';
        expect(tenantProvider('transcribe', 'voxpop')).toBe('elevenlabs');

        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'voxpop:workers-ai';
        expect(tenantProvider('transcribe', 'voxpop')).toBe('workers-ai');

        delete process.env.ANTIPHONY_APP_TRANSCRIBERS;
        expect(tenantProvider('transcribe', 'voxpop')).toBeUndefined();
    });
});

describe('tenantModel', () => {
    it('splits on the first colon so model IDs containing colons stay intact', () => {
        process.env.ANTIPHONY_APP_STT_MODELS = 'voxpop:scribe_v2,bardcast:@cf/openai/whisper:v1';

        expect(tenantModel('transcribe', 'voxpop')).toBe('scribe_v2');
        expect(tenantModel('transcribe', 'bardcast')).toBe('@cf/openai/whisper:v1');
        expect(tenantModel('transcribe', 'other')).toBeUndefined();
    });

    it('reads per-tenant assess models from ANTIPHONY_APP_ASSESS_MODELS', () => {
        process.env.ANTIPHONY_APP_ASSESS_MODELS = 'voxpop:@cf/cloudflare/clef';
        expect(tenantModel('assess', 'voxpop')).toBe('@cf/cloudflare/clef');
        expect(tenantModel('assess', 'other')).toBeUndefined();
    });
});

describe('tenantAssessSets', () => {
    it('parses appId:set+set pairs from ANTIPHONY_APP_ASSESS_SETS', () => {
        process.env.ANTIPHONY_APP_ASSESS_SETS = 'voxpop:quality+relevance, bardcast:quality';
        expect(tenantAssessSets('voxpop')).toEqual(['quality', 'relevance']);
        expect(tenantAssessSets('bardcast')).toEqual(['quality']);
        expect(tenantAssessSets('other')).toBeUndefined();
    });
});
