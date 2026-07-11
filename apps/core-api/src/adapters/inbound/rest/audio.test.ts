import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/audio?url=...`.
 *
 * Uses the standard `{success: false, error: {message}, requestId}` error
 * envelope (Phase 4 of envelope standardization).
 */

// StorageService.extractObjectPath + getSignedUrl are what the route touches.
// Mock them via the core-services-firebase module so the route sees our stubs.
const extractObjectPath = vi.fn();
const getSignedUrl = vi.fn();

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    StorageService: {
        extractObjectPath: (url: string) => extractObjectPath(url),
        getSignedUrl: (path: string) => getSignedUrl(path),
    },
    userService: {},
    audioPostService: {},
}));

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
    getAdminAuth: () => ({}),
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

    it('redirects to a signed URL for a valid blobs/ path', async () => {
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreicid');
        getSignedUrl.mockResolvedValue('https://signed.example.com/blobs/app-1/bafyreicid?sig=xyz');

        const res = await app().request(
            '/api/v1/audio?url=' +
                encodeURIComponent('https://storage.googleapis.com/bucket/blobs/app-1/bafyreicid'),
            { redirect: 'manual' },
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(
            'https://signed.example.com/blobs/app-1/bafyreicid?sig=xyz',
        );
        expect(res.headers.get('cache-control')).toContain('max-age=3000');
    });

    it('returns 404 when the signed-URL generation fails', async () => {
        extractObjectPath.mockReturnValue('blobs/app-1/bafyreimissing');
        getSignedUrl.mockRejectedValue(new Error('object not found'));

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('https://storage.googleapis.com/bucket/blobs/app-1/bafyreimissing'),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Audio not found' },
        });
    });
});
