import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/users/:handle`.
 *
 * Pre-bearer-bridge scope: viewer is always null, so `isSelf` is always
 * false and every response goes through `toProfileViewBasic`. These tests
 * cover that anonymous path.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    userService: {
        getUserData: vi.fn(),
    },
    promptService: {},
    organizationService: {},
    hydrationService: {},
    feedService: {},
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
const { userService } = await import('../services/core-services-firebase.js');

type MockProfile = ReturnType<typeof mkProfile>;

/**
 * Build a minimal ProfileView with owner-only PII fields (email,
 * phoneNumber, settings) so the stripping test can assert they're gone
 * in the `ProfileViewBasic` projection.
 */
function mkProfile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'u-1',
        handle: 'alice',
        displayName: 'Alice',
        avatarUrl: 'https://example.com/a.jpg',
        bio: 'hi',
        stats: { followers: 1, following: 2, prompts: 3 },
        badges: [],
        isVerified: false,
        createdAt: new Date().toISOString(),
        // Owner-only / admin-only fields:
        email: 'leak@example.com',
        phoneNumber: '+15555550123',
        settings: { notifications: true },
        unreadReplyCount: 5,
        blockedUsers: ['blocker-1'],
        reportCount: 0,
        isBanned: false,
        ...overrides,
    };
}

function asProfile(v: MockProfile) {
    return v as unknown as Awaited<ReturnType<typeof userService.getUserData>>;
}

describe('GET /api/v1/users/:handle', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns ProfileViewBasic (anonymous viewer — PII + admin stripped)', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfile(mkProfile()));

        const res = await app().request('/api/v1/users/alice');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.handle).toBe('alice');
        // PII + admin fields stripped by toProfileViewBasic.
        expect(body.data.email).toBeUndefined();
        expect(body.data.phoneNumber).toBeUndefined();
        expect(body.data.settings).toBeUndefined();
        expect(body.data.unreadReplyCount).toBeUndefined();
        expect(body.data.blockedUsers).toBeUndefined();
        expect(body.data.reportCount).toBeUndefined();
        expect(body.data.isBanned).toBeUndefined();
    });

    it('returns 404 when the user does not exist', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/nobody');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'User not found' });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(
            asProfile(mkProfile({ id: 'u-hdr', handle: 'bob' })),
        );

        const res = await app().request('/api/v1/users/bob', {
            headers: { 'x-request-id': 'trace-users' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-users');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(userService.getUserData).mockRejectedValue(new Error('firestore down'));

        const res = await app().request('/api/v1/users/boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
