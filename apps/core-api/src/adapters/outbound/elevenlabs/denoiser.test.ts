import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { elevenLabsDenoiser } from './denoiser.js';

/**
 * Unit tests for the Voice Isolator adapter, with `fetch` mocked — the live
 * behavior these encode was verified against the real API first (see
 * `specs/enrichment-pipeline-plan.md` step 3).
 *
 * The property under test is almost entirely about the RESULT MIME TYPE. The
 * endpoint transcodes to MP3 whatever it is given, so echoing the input type
 * would store MP3 bytes under the caller's original label and silently break
 * browser playback.
 */

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3.."

function mockResponse(body: Uint8Array, contentType: string | null, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => '',
    } as unknown as Response;
}

const fetchMock = vi.fn();
let savedKey: string | undefined;

beforeEach(() => {
    savedKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
});

afterEach(() => {
    // Restore, don't delete. Deleting would clear a developer's real key for
    // every test that runs after this file in the same process, silently
    // changing how those tests resolve providers — the same class of env
    // pollution this suite's sibling files already guard against.
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    vi.unstubAllGlobals();
});

describe('elevenLabsDenoiser', () => {
    it('reports the RESPONSE content type, not the input type', async () => {
        // The live API returns audio/mpeg for a webm upload. Echoing the input
        // would label MP3 bytes `audio/webm`; the blob is served to browsers
        // with its stored content type, so playback breaks with no error.
        fetchMock.mockResolvedValue(mockResponse(MP3_BYTES, 'audio/mpeg'));

        const result = await elevenLabsDenoiser.denoise({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'audio/webm',
        });

        expect(result.mimeType).toBe('audio/mpeg');
        expect(Array.from(result.bytes)).toEqual(Array.from(MP3_BYTES));
    });

    it('strips codec/charset parameters from the content type', async () => {
        // This value is stored as the blob content type and handed to browsers
        // verbatim, so it must be a bare media type.
        fetchMock.mockResolvedValue(mockResponse(MP3_BYTES, 'audio/mpeg; charset=binary'));
        const result = await elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' });
        expect(result.mimeType).toBe('audio/mpeg');
    });

    it('falls back to audio/mpeg when the header is missing', async () => {
        fetchMock.mockResolvedValue(mockResponse(MP3_BYTES, null));
        const result = await elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' });
        expect(result.mimeType).toBe('audio/mpeg');
    });

    it('ignores an application/json content type on a body that is audio', async () => {
        // The published docs claim this endpoint responds with JSON. If it ever
        // does label an audio body that way, storing it as JSON would break
        // playback — prefer the observed media type.
        fetchMock.mockResolvedValue(mockResponse(MP3_BYTES, 'application/json'));
        const result = await elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' });
        expect(result.mimeType).toBe('audio/mpeg');
    });

    it('throws on an empty body rather than storing silence', async () => {
        // A 200 with no body would content-address cleanly and replace playable
        // audio with an empty blob. Failing the stage is strictly better: the
        // original is untouched and the failure is visible on the view.
        fetchMock.mockResolvedValue(mockResponse(new Uint8Array(), 'audio/mpeg'));
        await expect(
            elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' }),
        ).rejects.toThrow(/empty body/);
    });

    it('throws with the status on a provider error', async () => {
        fetchMock.mockResolvedValue({
            ...mockResponse(new Uint8Array(), null, 422),
            text: async () => 'unprocessable',
        } as unknown as Response);
        await expect(
            elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' }),
        ).rejects.toThrow(/422/);
    });

    it('posts to the isolation endpoint with the audio field name', async () => {
        // `audio` here vs `file` for speech-to-text — an easy cross-wire.
        fetchMock.mockResolvedValue(mockResponse(MP3_BYTES, 'audio/mpeg'));
        await elevenLabsDenoiser.denoise({ bytes: MP3_BYTES, mimeType: 'audio/wav' });

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toContain('/audio-isolation');
        expect((init.body as FormData).has('audio')).toBe(true);
    });
});
