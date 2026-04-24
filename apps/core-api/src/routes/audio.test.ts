import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/audio?url=...`.
 *
 * Uses the `{status: 'error', message}` route-return shape (not the
 * `{success: false, error}` shape) per parity with apps/web.
 */

// StorageService.extractObjectPath + getSignedUrl are what the route touches.
// Mock them via the core-services-firebase module so the route sees our stubs.
const extractObjectPath = vi.fn();
const getSignedUrl = vi.fn();

vi.mock('../services/core-services-firebase.js', () => ({
    StorageService: {
        extractObjectPath: (url: string) => extractObjectPath(url),
        getSignedUrl: (path: string) => getSignedUrl(path),
    },
    userService: {},
    promptService: {},
    organizationService: {},
    hydrationService: {},
    feedService: {},
    rssService: {},
    firebaseCoreServices: {},
}));

// firebase-admin mock: `getAdminDb().collection('prompts').doc(id).get()` is
// used by the reply-audio path to verify the parent prompt exists.
const promptGetMock = vi.fn();

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (name: string) => ({
            doc: (id: string) => ({
                get: () => promptGetMock(name, id),
            }),
        }),
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

const { app } = await import('../app.js');

describe('GET /api/v1/audio', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns 400 when `url` query param is missing', async () => {
        const res = await app().request('/api/v1/audio');
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toEqual({ status: 'error', message: 'Missing "url" query parameter' });
    });

    it('returns 400 when the URL does not match a known storage format', async () => {
        extractObjectPath.mockReturnValue(null);
        const res = await app().request('/api/v1/audio?url=https://elsewhere.example.com/foo.mp3');
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toEqual({ status: 'error', message: 'Invalid audio URL' });
    });

    it('returns 403 when the extracted path is outside the allowlist prefixes', async () => {
        extractObjectPath.mockReturnValue('secrets/keys.json');
        const res = await app().request('/api/v1/audio?url=https://example.com/secrets/keys.json');
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body).toEqual({ status: 'error', message: 'Forbidden path' });
    });

    it('redirects to a signed URL for a valid audio/ path', async () => {
        extractObjectPath.mockReturnValue('audio/user-1/file.webm');
        getSignedUrl.mockResolvedValue('https://signed.example.com/audio/user-1/file.webm?sig=xyz');

        const res = await app().request(
            '/api/v1/audio?url=' +
                encodeURIComponent('https://storage.googleapis.com/bucket/audio/user-1/file.webm'),
            { redirect: 'manual' },
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(
            'https://signed.example.com/audio/user-1/file.webm?sig=xyz',
        );
        expect(res.headers.get('cache-control')).toContain('max-age=3000');
    });

    it('returns 404 for replies/ paths whose parent prompt does not exist', async () => {
        extractObjectPath.mockReturnValue('replies/missing-prompt/user_123.webm');
        promptGetMock.mockResolvedValue({ exists: false });

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('https://storage.googleapis.com/bucket/replies/missing-prompt/user_123.webm'),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ status: 'error', message: 'Not found' });
    });

    it('redirects for replies/ paths whose parent prompt exists', async () => {
        extractObjectPath.mockReturnValue('replies/live-prompt/user_456.webm');
        promptGetMock.mockResolvedValue({ exists: true });
        getSignedUrl.mockResolvedValue('https://signed.example.com/replies/live-prompt/user_456.webm?sig=abc');

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('https://storage.googleapis.com/bucket/replies/live-prompt/user_456.webm'),
            { redirect: 'manual' },
        );

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(
            'https://signed.example.com/replies/live-prompt/user_456.webm?sig=abc',
        );
    });

    it('returns 404 when the signed-URL generation fails', async () => {
        extractObjectPath.mockReturnValue('prompts/missing-object.webm');
        getSignedUrl.mockRejectedValue(new Error('object not found'));

        const res = await app().request(
            '/api/v1/audio?url=' + encodeURIComponent('https://storage.googleapis.com/bucket/prompts/missing-object.webm'),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ status: 'error', message: 'Audio not found' });
    });
});
