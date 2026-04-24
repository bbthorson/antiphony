import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/core-services-firebase.js', () => ({
    rssService: { parseFeed: vi.fn() },
    userService: {},
    promptService: {},
    replyService: {},
    organizationService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
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
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

const post = (body: unknown) =>
    app().request('/api/v1/onboarding/import-rss', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
        body: JSON.stringify(body),
    });

describe('POST /api/v1/onboarding/import-rss', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/onboarding/import-rss', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/feed' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid URL', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await post({ url: 'not-a-url' });
        expect(res.status).toBe(400);
    });

    it('422s when parseFeed returns null', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(rssService.parseFeed).mockResolvedValue(null);
        const res = await post({ url: 'https://example.com/feed' });
        expect(res.status).toBe(422);
    });

    it('returns podcast metadata with first 3 items', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(rssService.parseFeed).mockResolvedValue({
            title: 'My Cast',
            description: 'Stuff',
            image: 'https://x/img',
            link: 'https://x',
            items: [
                { title: 'E1' },
                { title: 'E2' },
                { title: 'E3' },
                { title: 'E4' },
            ],
        } as unknown as Awaited<ReturnType<typeof rssService.parseFeed>>);

        const res = await post({ url: 'https://example.com/feed' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.title).toBe('My Cast');
        expect(body.data.items).toHaveLength(3);
    });
});
