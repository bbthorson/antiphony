import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/users/:handle/profile`.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {
        getUserProfileData: vi.fn(),
    },
    userService: {},
    promptService: {},
    organizationService: {},
    hydrationService: {},
    rssService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
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

const { app } = await import('../../../app.js');
const { feedService } = await import('../../outbound/firebase/core-services-firebase.js');

type MockProfileData = ReturnType<typeof mkProfileData>;

function mkProfileData() {
    return {
        profileUser: { id: 'u-1', handle: 'alice', displayName: 'Alice' },
        allPromptsWithReplies: [
            {
                record: { id: 'p-1', authorId: 'u-1', title: 'A', status: 'live', createdAt: '2026-04-01T00:00:00Z', audioUrl: '' },
                author: { id: 'u-1', handle: 'alice' },
                replyCount: 0,
                lastReplyAt: null,
                likeCount: 0,
                visibility: 'public',
                replies: [],
            },
        ],
        repliers: [],
    };
}

function asProfileData(v: MockProfileData) {
    return v as unknown as Awaited<ReturnType<typeof feedService.getUserProfileData>>;
}

describe('GET /api/v1/users/:handle/profile', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the aggregated profile payload', async () => {
        vi.mocked(feedService.getUserProfileData).mockResolvedValue(asProfileData(mkProfileData()));

        const res = await app().request('/api/v1/users/alice/profile');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.profileUser.handle).toBe('alice');
        expect(body.data.allPromptsWithReplies).toHaveLength(1);
        expect(body.data.repliers).toEqual([]);
    });

    it('returns 404 when the user cannot be resolved', async () => {
        vi.mocked(feedService.getUserProfileData).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/nobody/profile');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'User not found' });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(feedService.getUserProfileData).mockResolvedValue(asProfileData(mkProfileData()));

        const res = await app().request('/api/v1/users/alice/profile', {
            headers: { 'x-request-id': 'trace-uprofile' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-uprofile');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(feedService.getUserProfileData).mockRejectedValue(new Error('firestore outage'));

        const res = await app().request('/api/v1/users/alice/profile');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
