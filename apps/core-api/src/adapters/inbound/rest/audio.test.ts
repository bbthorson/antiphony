import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/audio?url=...`.
 *
 * Uses the standard `{success: false, error: {message}, requestId}` error
 * envelope (Phase 4 of envelope standardization).
 */

// StorageService.extractObjectPath + openStream are what the route touches.
// Mock them via the core-services-firebase module so the route sees our stubs.
const extractObjectPath = vi.fn();
const openStream = vi.fn();

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        storage: {
            extractObjectPath: (url: string) => extractObjectPath(url),
            openStream: (path: string, range?: unknown) => openStream(path, range),
        },
    // The rate-limit middleware resolves its store from here now, rather
    // than defaulting to the Firestore binding. Under limit on every hit:
    // these suites assert route behaviour, not rate-limit policy (that is
    // middleware/rate-limit.test.ts).
    rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

/** A `BlobRead` over fixed bytes, for the streaming assertions below. */
function read(bytes: number[], over: Record<string, unknown> = {}) {
    return {
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
            },
        }),
        size: bytes.length,
        totalSize: bytes.length,
        mimeType: 'audio/webm',
        ...over,
    };
}

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        // Rate-limit middleware touches Firestore; give it inert stubs.
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async (fn: (t: unknown) => Promise<boolean>) =>
            fn({
                get: async () => ({ exists: false, data: () => undefined }),
                set: () => undefined,
                update: () => undefined,
            }),
    }),
    getAdmin: () => ({
        firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } },
    }),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');

describe('GET /api/v1/audio', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns 400 when `url` query param is missing', async () => {
        const res = await app().request('/api/v1/audio');
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Missing "url" query parameter' },
        });
    });

    it('returns 400 when the URL does not match a known storage format', async () => {
        extractObjectPath.mockReturnValue(null);
        const res = await app().request('/api/v1/audio?url=https://elsewhere.example.com/foo.mp3');
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Invalid audio URL' },
        });
    });

    it('returns 403 when the extracted path is outside the blobs/ namespace', async () => {
        extractObjectPath.mockReturnValue('secrets/keys.json');
        const res = await app().request('/api/v1/audio?url=https://example.com/secrets/keys.json');
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Forbidden path' },
        });
    });

    it('returns 403 for legacy (pre-blobs) storage prefixes', async () => {
        // `audio/`, `prompts/`, and `replies/` were the Vox Pop-era layout;
        // the served namespace is content-addressed `blobs/` only.
        for (const path of ['audio/user-1/file.webm', 'prompts/p1.webm', 'replies/p1/u1.webm']) {
            extractObjectPath.mockReturnValue(path);
            const res = await app().request(
                '/api/v1/audio?url=' +
                    encodeURIComponent(`https://storage.googleapis.com/bucket/${path}`),
            );
            expect(res.status).toBe(403);
        }
    });

    it('returns 403 for path-traversal attempts even when the prefix matches', async () => {
        // `blobs/..` passes the `startsWith('blobs/')` check but escapes
        // the allowlist conceptually. Defense-in-depth — GCS's flat
        // namespace makes this non-exploitable, but a future storage
        // backend that interprets path segments (filesystem, etc.)
        // shouldn't be able to bypass the allowlist.
        extractObjectPath.mockReturnValue('blobs/../secrets/keys.json');
        const res = await app().request(
            '/api/v1/audio?url=' +
                encodeURIComponent('https://storage.googleapis.com/bucket/blobs/../secrets/keys.json'),
        );
        expect(res.status).toBe(403);
    });

    it('streams the bytes for a valid blobs/ path', async () => {
        // Was a 302 to a signed GCS URL. It now serves the bytes: R2 bindings
        // cannot mint presigned URLs, and streaming is the better shape anyway
        // (no credential, no expiry, free egress, working range requests).
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreicid');
        openStream.mockResolvedValue(read([1, 2, 3, 4]));

        const res = await app().request(
            '/api/v1/audio?url=' +
                encodeURIComponent('https://storage.googleapis.com/bucket/blobs/app-1/bafyreicid'),
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/webm');
        expect(res.headers.get('content-length')).toBe('4');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        // Content-addressed, so the bytes behind a CID never change. The signed
        // URL could only ever be `private, max-age=3000` because it expired.
        expect(res.headers.get('cache-control')).toContain('immutable');
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    });

    it('accepts a bare object path, not just a provider URL', async () => {
        // What `audioPlaybackUrl` now emits, and what this endpoint's OpenAPI
        // description always claimed to take.
        extractObjectPath.mockReturnValue(null);
        openStream.mockResolvedValue(read([9]));

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('blobs/app-1/bafyreicid'),
        );
        expect(res.status).toBe(200);
        expect(openStream).toHaveBeenCalledWith('blobs/app-1/bafyreicid', undefined);
    });

    it('rejects a foreign URL rather than reinterpreting it as a path', async () => {
        // The bare-path fallback must not become an SSRF hole: anything with a
        // scheme fails the URL parse and must NOT then be read as relative.
        extractObjectPath.mockReturnValue(null);
        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('https://evil.example/blobs/app-1/cid'),
        );
        expect(res.status).toBe(400);
        expect(openStream).not.toHaveBeenCalled();
    });

    it('serves a 206 with Content-Range for a ranged request', async () => {
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreicid');
        openStream.mockResolvedValue(read([20, 30], { size: 2, totalSize: 5 }));

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('blobs/app-1/bafyreicid'),
            { headers: { range: 'bytes=1-2' } },
        );

        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe('bytes 1-2/5');
        expect(openStream).toHaveBeenCalledWith('blobs/app-1/bafyreicid', {
            offset: 1,
            length: 2,
        });
    });

    it('ignores an unparseable Range header and serves the whole object', async () => {
        // RFC 9110 permits ignoring a Range we do not understand, and that is
        // the safe failure: a misparsed range serves the wrong bytes under a
        // 206 claiming they are right.
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreicid');
        openStream.mockResolvedValue(read([1, 2, 3]));

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('blobs/app-1/bafyreicid'),
            { headers: { range: 'bytes=0-1,5-6' } },
        );
        expect(res.status).toBe(200);
        expect(openStream).toHaveBeenCalledWith('blobs/app-1/bafyreicid', undefined);
    });

    it('returns 404 when the object does not exist', async () => {
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreimissing');
        openStream.mockResolvedValue(null);

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('blobs/app-1/bafyreimissing'),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Audio not found' },
        });
    });
});

describe('GET /api/v1/audio?format= — derived renditions', () => {
    beforeEach(() => {
        // Reset first — the suite above resets in its own `beforeEach`, and a
        // describe-level hook here REPLACES nothing, it just runs after. Call
        // counts leak between cases without this.
        vi.resetAllMocks();
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreicid');
    });

    it('serves the derived object, not the canonical one', async () => {
        openStream.mockResolvedValue(read([1, 2, 3], { mimeType: 'audio/mpeg' }));

        const res = await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid&format=mp3');

        expect(res.status).toBe(200);
        // The path is derived from the source's own tenant and CID — no lookup,
        // which on a cache hit is the whole request.
        expect(openStream).toHaveBeenCalledWith('renditions/app-1/bafyreicid.mp3', undefined);
    });

    it('leaves the canonical path untouched when no format is asked for', async () => {
        openStream.mockResolvedValue(read([1, 2, 3]));

        await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid');

        expect(openStream).toHaveBeenCalledWith('blobs/app-1/bafyreicid', undefined);
    });

    it('types the response from the FORMAT, not from the store', async () => {
        // The store reports whatever was set when the object was written. An
        // mp3 served as application/octet-stream because a Content-Type went
        // missing is the kind of thing Twilio answers by playing nothing.
        openStream.mockResolvedValue(read([1, 2, 3], { mimeType: undefined }));

        const res = await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid&format=mp3');

        expect(res.headers.get('content-type')).toBe('audio/mpeg');
    });

    it('400s an unsupported format rather than serving the canonical bytes', async () => {
        // Falling back to webm/opus is the worst available answer for the one
        // caller this exists for: Twilio cannot decode it and does not say so.
        const res = await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid&format=wav');

        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toMatch(/Unsupported format/);
        expect(openStream).not.toHaveBeenCalled();
    });

    it('does not let a format value reach the storage key as caller bytes', async () => {
        const res = await app().request(
            '/api/v1/audio?url=blobs/app-1/bafyreicid&format=' + encodeURIComponent('mp3 -f concat'),
        );

        expect(res.status).toBe(400);
        expect(openStream).not.toHaveBeenCalled();
    });

    it('404s a missing rendition with a message that names the format', async () => {
        // Until the transcode service lands, a miss is the honest answer for
        // anything not pre-warmed — and the message has to distinguish "this
        // audio does not exist" from "this audio has no mp3 yet".
        openStream.mockResolvedValue(null);

        const res = await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid&format=mp3');

        expect(res.status).toBe(404);
        expect((await res.json()).error.message).toMatch(/no mp3 rendition/i);
    });

    it('still refuses a path outside the served namespace', async () => {
        extractObjectPath.mockReturnValue('secrets/keys.json');

        const res = await app().request('/api/v1/audio?url=x&format=mp3');

        expect(res.status).toBe(403);
        expect(openStream).not.toHaveBeenCalled();
    });

    it('serves a range from the rendition, not from the source', async () => {
        openStream.mockResolvedValue(
            read([2, 3], { size: 2, totalSize: 9, mimeType: 'audio/mpeg' }),
        );

        const res = await app().request('/api/v1/audio?url=blobs/app-1/bafyreicid&format=mp3', {
            headers: { range: 'bytes=1-2' },
        });

        expect(res.status).toBe(206);
        expect(openStream).toHaveBeenCalledWith('renditions/app-1/bafyreicid.mp3', {
            offset: 1,
            length: 2,
        });
    });
});
