import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { selectTranscriber } from './provider-registry.js';

/**
 * End-to-end check on the one thing the two unit suites cannot see between
 * them: that a tenant's pinned model actually reaches the provider request.
 *
 * `audio-processing.test.ts` proves the registry picks the right ENTRY per
 * tenant; `elevenlabs/transcriber.test.ts` proves a bound model reaches
 * `model_id`. Neither proves the binding is wired between them, which is the
 * whole feature — so this stubs fetch and reads the outgoing form.
 */

const ENV = [
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_STT_MODEL',
    'ANTIPHONY_TRANSCRIBER',
    'ANTIPHONY_APP_TRANSCRIBERS',
    'ANTIPHONY_APP_STT_MODELS',
] as const;
const saved: Record<string, string | undefined> = {};

const fetchMock = vi.fn();

beforeEach(() => {
    for (const key of ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    process.env.ELEVENLABS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(
        async () =>
            new Response(JSON.stringify({ language_code: 'eng', text: 'hi.', words: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
    );
});

afterEach(() => {
    for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
});

const modelSent = () => (fetchMock.mock.calls[0]![1].body as FormData).get('model_id');

async function transcribeAs(originAppId?: string) {
    const transcriber = selectTranscriber(originAppId);
    expect(transcriber).toBeDefined();
    await transcriber!.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' });
}

describe('per-tenant model binding', () => {
    it('sends the tenant pinned model', async () => {
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        await transcribeAs('acme');
        expect(modelSent()).toBe('scribe_v1');
    });

    it('sends the deployment model for a tenant with no pin', async () => {
        process.env.ELEVENLABS_STT_MODEL = 'scribe_v2';
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        await transcribeAs('vox-pop');
        expect(modelSent()).toBe('scribe_v2');
    });

    it('lets a tenant pin beat the deployment model', async () => {
        process.env.ELEVENLABS_STT_MODEL = 'scribe_v2';
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        await transcribeAs('acme');
        expect(modelSent()).toBe('scribe_v1');
    });

    it('ignores tenant models entirely when no tenant is named', async () => {
        // `resolveProviders()` with no app id is the deployment-wide wiring; a
        // tenant pin must not leak into it.
        process.env.ELEVENLABS_STT_MODEL = 'scribe_v2';
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        await transcribeAs();
        expect(modelSent()).toBe('scribe_v2');
    });

    it('does not carry one tenant model over to the next resolution', async () => {
        // The factory closes over the model, so a leaked instance would serve
        // the wrong tenant. Resolution is per call precisely to prevent that.
        //
        // The deployment model is set to a value that is neither the pin nor
        // the adapter default, so the second assertion can only pass by
        // resolving afresh for `vox-pop` — not by coincidentally matching
        // whatever `scribe_v2` happens to mean.
        process.env.ELEVENLABS_STT_MODEL = 'deployment-model';
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        await transcribeAs('acme');
        expect(modelSent()).toBe('scribe_v1');

        fetchMock.mockClear();
        await transcribeAs('vox-pop');
        expect(modelSent()).toBe('deployment-model');
    });

    it('runs the stage on the provider default when the provider has no model', async () => {
        // `stub` does not accept a model. The pin is reported, not obeyed, and
        // crucially the stage still runs — an ignorable model is not a reason
        // to deny a tenant transcription.
        process.env.ANTIPHONY_APP_TRANSCRIBERS = 'acme:stub';
        process.env.ANTIPHONY_APP_STT_MODELS = 'acme:scribe_v1';
        const transcriber = selectTranscriber('acme');
        expect(transcriber).toBeDefined();
        const result = await transcriber!.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' });
        expect(result.model).toBe('stub');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
