import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindWorkersAi, setWorkersAiForTest, workersAi } from './binding.js';
import { bytesToBase64, toSegments, workersAiTranscriber } from './transcriber.js';

const input = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg', durationMs: 4000 };

function fakeAi(output: unknown) {
    return { run: vi.fn().mockResolvedValue(output) };
}

beforeEach(() => {
    setWorkersAiForTest(undefined);
    delete process.env.WORKERS_AI_STT_MODEL;
});

afterEach(() => {
    setWorkersAiForTest(undefined);
    delete process.env.WORKERS_AI_STT_MODEL;
});

describe('bindWorkersAi', () => {
    it('binds env.AI and ignores anything without run()', () => {
        bindWorkersAi(undefined);
        bindWorkersAi({ AI: {} });
        expect(workersAi()).toBeUndefined();

        const ai = fakeAi({});
        bindWorkersAi({ AI: ai });
        expect(workersAi()).toBe(ai);
    });
});

describe('workersAiTranscriber', () => {
    it('throws when the binding is missing', async () => {
        await expect(workersAiTranscriber().transcribe(input)).rejects.toThrow(/not bound/);
    });

    it('sends base64 audio, the trimmed language hint and VAD to the default model', async () => {
        const ai = fakeAi({ text: 'hi' });
        setWorkersAiForTest(ai);

        await workersAiTranscriber().transcribe({ ...input, langHint: 'en_US' });

        expect(ai.run).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', {
            audio: 'AQID',
            language: 'en',
            vad_filter: true,
        });
    });

    it('prefers a tenant model over WORKERS_AI_STT_MODEL over the default', async () => {
        const ai = fakeAi({ text: 'hi' });
        setWorkersAiForTest(ai);
        process.env.WORKERS_AI_STT_MODEL = '@cf/openai/whisper';

        const envResult = await workersAiTranscriber().transcribe(input);
        const tenantResult = await workersAiTranscriber('@cf/tenant/model').transcribe(input);

        expect(envResult.model).toBe('@cf/openai/whisper');
        expect(tenantResult.model).toBe('@cf/tenant/model');
    });

    it('maps segments to ms, normalizes the language, and keeps the text rollup', async () => {
        setWorkersAiForTest(
            fakeAi({
                text: ' Hello there. How are you? ',
                segments: [
                    { start: 0, end: 1.25, text: ' Hello there.' },
                    { start: 1.25, end: 2.5, text: ' How are you?' },
                ],
                transcription_info: { language: 'eng' },
            }),
        );

        const result = await workersAiTranscriber().transcribe(input);

        expect(result.transcript).toEqual({
            segments: [
                { startMs: 0, endMs: 1250, text: 'Hello there.' },
                { startMs: 1250, endMs: 2500, text: 'How are you?' },
            ],
            text: 'Hello there. How are you?',
        });
        expect(result.lang).toBe('en');
    });

    it('falls back to one whole-clip segment when only text comes back', async () => {
        setWorkersAiForTest(fakeAi({ text: 'just text' }));
        const result = await workersAiTranscriber().transcribe(input);
        expect(result.transcript.segments).toEqual([{ startMs: 0, endMs: 4000, text: 'just text' }]);
    });

    it('throws on an unexpected output shape rather than saving an empty transcript', async () => {
        setWorkersAiForTest(fakeAi('nope'));
        await expect(workersAiTranscriber().transcribe(input)).rejects.toThrow(/unexpected shape/);
    });
});

describe('toSegments', () => {
    it('drops empty text and never inverts a span', () => {
        expect(
            toSegments([
                { start: 2, end: 1, text: 'backwards' },
                { start: 3, end: 4, text: '   ' },
                { start: -1, end: Number.NaN, text: 'bad numbers' },
            ]),
        ).toEqual([
            { startMs: 2000, endMs: 2000, text: 'backwards' },
            { startMs: 0, endMs: 0, text: 'bad numbers' },
        ]);
    });
});

describe('bytesToBase64', () => {
    it('matches btoa across chunk boundaries', () => {
        const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    });
});
