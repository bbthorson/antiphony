import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/utils/parse-rss`.
 *
 * Matches apps/web's idiosyncratic success envelope (`{status: 'success', data}`).
 */

vi.mock('../services/core-services-firebase.js', () => ({
    rssService: { parseFeed: vi.fn() },
    userService: {},
    promptService: {},
    organizationService: {},
    hydrationService: {},
    feedService: {},
    StorageService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
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

const { app } = await import('../app.js');
const { rssService } = await import('../services/core-services-firebase.js');

describe('POST /api/v1/utils/parse-rss', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("returns the normalized summary (note legacy `status: 'success'` envelope)", async () => {
        vi.mocked(rssService.parseFeed).mockResolvedValue({
            title: 'Example Feed',
            description: 'About stuff',
            image: 'https://example.com/image.png',
            link: 'https://example.com',
            items: [],
            lastFetchedAt: new Date(),
        });

        const res = await app().request('/api/v1/utils/parse-rss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/feed.xml' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        // NOT `success: true` — apps/web uses this shape, we mirror exactly.
        expect(body.status).toBe('success');
        expect(body.data).toEqual({
            title: 'Example Feed',
            description: 'About stuff',
            image: 'https://example.com/image.png',
            link: 'https://example.com',
        });
        // Items and lastFetchedAt are NOT returned — the handler projects
        // down to title/description/image/link only.
        expect(body.data.items).toBeUndefined();
        expect(body.data.lastFetchedAt).toBeUndefined();
    });

    it('returns 400 with Zod issues on invalid body', async () => {
        const res = await app().request('/api/v1/utils/parse-rss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'not-a-url' }),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Invalid request body');
        expect(Array.isArray(body.issues)).toBe(true);
    });

    it('returns 400 on missing body', async () => {
        const res = await app().request('/api/v1/utils/parse-rss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '',
        });

        expect(res.status).toBe(400);
    });

    it('returns 400 when the feed cannot be parsed', async () => {
        vi.mocked(rssService.parseFeed).mockResolvedValue(null);

        const res = await app().request('/api/v1/utils/parse-rss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/broken.xml' }),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toEqual({
            status: 'error',
            message: 'Failed to parse RSS feed or invalid URL',
        });
    });
});
