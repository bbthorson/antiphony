import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpTrimmer, httpWaveform } from './stages.js';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * The ingest stages over HTTP.
 *
 * These adapters replaced in-process `execFile` ones, and the thing worth
 * testing is not the transcode — that lives in `apps/audio-rendition` and is
 * tested there against a real ffmpeg. It is that a MALFORMED or degenerate
 * response does not become a stored artifact.
 *
 * Every guard here corresponds to a failure that would otherwise be silent:
 *
 *   - Empty bytes get content-addressed and stored as a valid-looking blob,
 *     replacing playable audio with nothing.
 *   - A missing duration becomes `processedDurationMs`, which the read view
 *     serves to clients as the post's duration — a guess is served as fact.
 *   - A missing content type gets stored as the blob's type, and blobs are
 *     served to browsers with it, so playback breaks with no exception and
 *     nothing in the logs.
 *   - Empty peaks settle the stage `ready` over a waveform that renders as
 *     nothing.
 *
 * Each of those settles a stage as SUCCESS over broken output, which is the one
 * outcome the processing pipeline cannot detect for itself.
 */

const loggerStub = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const CONFIG = { baseUrl: 'https://rendition.test', systemAuthToken: 'sys-tok-abc' };
const INPUT = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' };

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Stub `globalThis.fetch`, since these adapters take no injected impl. */
function stubFetch(response: Response | (() => Promise<Response>)) {
    const impl = typeof response === 'function' ? response : async () => response;
    const spy = vi.fn(impl);
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
}

function trimResponse(bytes: number[], headers: Record<string, string>) {
    return new Response(new Uint8Array(bytes), { status: 200, headers });
}

describe('httpTrimmer', () => {
    it('posts the bytes with the input mime type as Content-Type', async () => {
        // The mime type IS a content type — no multipart envelope, and no base64
        // that would inflate a 25MB upload by a third to carry one string.
        const spy = stubFetch(
            trimResponse([9, 9], { 'content-type': 'audio/webm', 'x-duration-ms': '3300' }),
        );

        await httpTrimmer(CONFIG, loggerStub()).trim(INPUT);

        const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://rendition.test/trim');
        expect((init.headers as Record<string, string>)['content-type']).toBe('audio/mpeg');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sys-tok-abc');
    });

    it('returns the trimmed bytes, output mime type and measured duration', async () => {
        stubFetch(trimResponse([9, 9], { 'content-type': 'audio/webm', 'x-duration-ms': '3300' }));

        const result = await httpTrimmer(CONFIG, loggerStub()).trim(INPUT);

        expect(Array.from(result.bytes)).toEqual([9, 9]);
        // The output type need not match the input — the trimmer re-encodes to
        // Opus/WebM to undo Voice Isolator's 320kbps MP3 inflation.
        expect(result.mimeType).toBe('audio/webm');
        expect(result.durationMs).toBe(3300);
    });

    it('THROWS on an empty variant rather than storing it', async () => {
        stubFetch(trimResponse([], { 'content-type': 'audio/webm', 'x-duration-ms': '3300' }));

        await expect(httpTrimmer(CONFIG, loggerStub()).trim(INPUT)).rejects.toThrow(/empty variant/);
    });

    const BAD_DURATIONS: [Record<string, string>, string][] = [
        [{ 'content-type': 'audio/webm' }, 'no duration header'],
        [{ 'content-type': 'audio/webm', 'x-duration-ms': 'soon' }, 'an unparseable duration'],
        [{ 'content-type': 'audio/webm', 'x-duration-ms': '0' }, 'a zero duration'],
        [{ 'content-type': 'audio/webm', 'x-duration-ms': '-5' }, 'a negative duration'],
    ];

    it.each(BAD_DURATIONS)('throws on %j (%s)', async (headers) => {
        // A guess here is served to clients as the post's duration. Failing the
        // stage leaves the record's original value, which is at least true of
        // the original audio.
        stubFetch(trimResponse([9, 9], headers));

        await expect(httpTrimmer(CONFIG, loggerStub()).trim(INPUT)).rejects.toThrow(/duration/);
    });

    it('throws when the service reports a failure', async () => {
        // Thrown, not swallowed. Unlike the rendition read path — where a
        // failure means "serve without one" — `AudioProcessingService` catches
        // per stage and settles it `failed`, which is the honest record.
        stubFetch(new Response('boom', { status: 502 }));

        await expect(httpTrimmer(CONFIG, loggerStub()).trim(INPUT)).rejects.toThrow(/\/trim failed \(502\)/);
    });
});

describe('httpWaveform', () => {
    it('returns the peaks', async () => {
        stubFetch(Response.json({ peaks: [0, 50, 100] }));

        const result = await httpWaveform(CONFIG, loggerStub()).waveform(INPUT);

        expect(result.peaks).toEqual([0, 50, 100]);
    });

    it('posts to /waveform with the bearer', async () => {
        const spy = stubFetch(Response.json({ peaks: [1] }));

        await httpWaveform(CONFIG, loggerStub()).waveform(INPUT);

        const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://rendition.test/waveform');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sys-tok-abc');
    });

    const BAD_PEAKS: [unknown, string][] = [
        [{ peaks: [] }, 'an empty array'],
        [{}, 'no peaks key'],
        [{ peaks: 'lots' }, 'a non-array'],
    ];

    it.each(BAD_PEAKS)('throws on %j (%s)', async (body) => {
        // Empty peaks would settle the stage `ready` over a waveform that
        // renders as nothing, while claiming to have replaced whatever the
        // client supplied.
        stubFetch(Response.json(body));

        await expect(httpWaveform(CONFIG, loggerStub()).waveform(INPUT)).rejects.toThrow(/peaks/);
    });

    it('throws on non-numeric peaks rather than passing them through', async () => {
        // These are rendered as bar heights. A string in the array is a broken
        // strip, or a crash, in whatever renders it.
        stubFetch(Response.json({ peaks: [1, '2', 3] }));

        await expect(httpWaveform(CONFIG, loggerStub()).waveform(INPUT)).rejects.toThrow(
            /non-numeric/,
        );
    });

    it('throws when the service reports a failure', async () => {
        stubFetch(new Response('boom', { status: 502 }));

        await expect(httpWaveform(CONFIG, loggerStub()).waveform(INPUT)).rejects.toThrow(
            /\/waveform failed \(502\)/,
        );
    });
});
