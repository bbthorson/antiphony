import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/organizations/slug/:slug/profile`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    feedService: {
        getOrgProfileData: vi.fn(),
    },
    userService: {},
    promptService: {},
    organizationService: {},
    hydrationService: {},
    rssService: {},
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
const { feedService } = await import('../services/core-services-firebase.js');

type MockOrgProfile = ReturnType<typeof mkOrgProfile>;

function mkOrgProfile(options: { rssSummary?: unknown } = {}) {
    return {
        org: {
            record: { id: 'o-1', slug: 'acme', name: 'Acme', ownerId: 'owner-1', createdAt: '' },
            memberCount: 3,
            currentUserRole: undefined,
        },
        prompts: [
            {
                record: { id: 'p-1', authorId: 'u-1', title: 'A', status: 'live', createdAt: '', audioUrl: '' },
                author: { id: 'u-1', handle: 'alice' },
                replyCount: 0,
                lastReplyAt: null,
                likeCount: 0,
                visibility: 'public',
            },
        ],
        rssSummary: (options.rssSummary as unknown) ?? null,
    };
}

function asOrgProfile(v: MockOrgProfile) {
    return v as unknown as Awaited<ReturnType<typeof feedService.getOrgProfileData>>;
}

describe('GET /api/v1/organizations/slug/:slug/profile', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the aggregated org-profile payload (no RSS)', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue(asOrgProfile(mkOrgProfile()));

        const res = await app().request('/api/v1/organizations/slug/acme/profile');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.org.record.slug).toBe('acme');
        expect(body.data.prompts).toHaveLength(1);
        expect(body.data.rssSummary).toBeNull();
    });

    it('returns the RSS summary when present', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue(
            asOrgProfile(mkOrgProfile({ rssSummary: { title: 'Acme Feed', items: [] } })),
        );

        const res = await app().request('/api/v1/organizations/slug/acme/profile');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.rssSummary).toEqual({ title: 'Acme Feed', items: [] });
    });

    it('returns 404 when the slug does not resolve', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/slug/missing/profile');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'Organization not found' });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue(asOrgProfile(mkOrgProfile()));

        const res = await app().request('/api/v1/organizations/slug/acme/profile', {
            headers: { 'x-request-id': 'trace-orgprof' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-orgprof');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(feedService.getOrgProfileData).mockRejectedValue(new Error('rss fetch failed'));

        const res = await app().request('/api/v1/organizations/slug/acme/profile');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
