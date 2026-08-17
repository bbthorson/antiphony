import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The HTTP surface.
 *
 * The load-bearing assertion here is that `/render` is **closed**. The service
 * this was adopted from is public, because Twilio fetches `<Play>` URLs
 * anonymously and cannot present a bearer — and every defence in it exists to
 * make a public transcoder safe. Here the anonymous surface is core-api's audio
 * proxy and this is reached only by core-api, so an unauthenticated request
 * getting through would not be a small regression: it would be an open
 * transcoder with a write path into Antiphony's own bucket.
 */

process.env.LOG_LEVEL = 'silent';

const buildRendition = vi.fn();

vi.mock('./rendition.js', async (importOriginal) => ({
    // The real `parseRequest` / `InvalidRequestError`, so the validation
    // boundary is exercised rather than mocked past — only the transcode is
    // stubbed.
    ...((await importOriginal()) as object),
    buildRendition,
}));

const { createApp } = await import('./app.js');

const TOKEN = 'sys-tok-abcdefghijklmnopqrstuvwxyz01234';
const BODY = { originAppId: 'vox-pop', cid: 'bafkreiabc', format: 'mp3' };

function post(body: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return createApp().request('/render', {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    process.env.SYSTEM_AUTH_TOKEN = TOKEN;
    buildRendition.mockResolvedValue({
        path: 'renditions/vox-pop/bafkreiabc.mp3',
        bytes: 1234,
        transcoded: true,
    });
});

afterEach(() => {
    delete process.env.SYSTEM_AUTH_TOKEN;
});

describe('GET /health', () => {
    it('answers unauthenticated, and reports the commit', async () => {
        // Unauthenticated on purpose: a probe and the deploy smoke test both
        // reach it, and it carries no information a caller could not infer.
        const res = await createApp().request('/health');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok', service: 'audio-rendition' });
    });
});

describe('POST /render — authorisation', () => {
    it('401s with no bearer', async () => {
        const res = await post(BODY, null);

        expect(res.status).toBe(401);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('401s on a wrong bearer', async () => {
        const res = await post(BODY, 'wrong-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa');

        expect(res.status).toBe(401);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('503s — and transcodes nothing — when no token is configured', async () => {
        // Fail-closed. Downgrading to "allow everything" on a missing secret
        // would turn a config gap into an open transcoder with a write path
        // into Antiphony's bucket. 503 rather than 500 because the service is
        // not misbehaving, it is not configured.
        delete process.env.SYSTEM_AUTH_TOKEN;

        const res = await post(BODY);

        expect(res.status).toBe(503);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('does not accept the empty string as a token', async () => {
        // An empty `SYSTEM_AUTH_TOKEN` is the shape a misconfigured secret
        // mount takes, and it must read as "unset" rather than as a token that
        // an empty bearer would match.
        process.env.SYSTEM_AUTH_TOKEN = '   ';

        expect((await post(BODY, ' ')).status).toBe(503);
    });

    it('proceeds on the right bearer', async () => {
        const res = await post(BODY);

        expect(res.status).toBe(200);
        expect(buildRendition).toHaveBeenCalledWith(BODY);
    });
});

describe('POST /render — request handling', () => {
    it('returns the rendition path rather than the bytes', async () => {
        // Both ends talk to R2 directly. Passing the audio back through the
        // Worker would put a second copy of a multi-megabyte blob in a 128MB
        // isolate for no benefit.
        const res = await post(BODY);

        expect(await res.json()).toEqual({
            path: 'renditions/vox-pop/bafkreiabc.mp3',
            bytes: 1234,
            transcoded: true,
        });
    });

    it('400s a malformed body', async () => {
        expect((await post('{not json')).status).toBe(400);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('400s an unsupported format, before any transcode', async () => {
        const res = await post({ ...BODY, format: 'wav' });

        expect(res.status).toBe(400);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('400s a path segment that would escape its namespace', async () => {
        const res = await post({ ...BODY, cid: '../../secrets' });

        expect(res.status).toBe(400);
        expect(buildRendition).not.toHaveBeenCalled();
    });

    it('404s a missing source, distinctly from a transcode failure', async () => {
        // The caller has to tell "your input is wrong" from "my ffmpeg broke",
        // or a missing blob sends someone reading ffmpeg logs.
        const { InvalidRequestError } = await import('./rendition.js');
        buildRendition.mockRejectedValueOnce(new InvalidRequestError('no source blob at blobs/x/y'));

        expect((await post(BODY)).status).toBe(404);
    });

    it('502s a transcode failure', async () => {
        // The caller treats a non-2xx as "no rendition available" and answers
        // its own request accordingly, so failing loudly degrades rather than
        // breaks.
        buildRendition.mockRejectedValueOnce(new Error('ffmpeg exited with code 1'));

        expect((await post(BODY)).status).toBe(502);
    });
});
