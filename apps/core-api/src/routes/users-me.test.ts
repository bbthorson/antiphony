import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/users/me` + `GET /api/v1/users/me/organizations`.
 *
 * Both are `requireAuth()`-gated — anonymous request → 401, invalid token →
 * 401, valid token → pass through to the handler which echoes the viewer's
 * profile / org list.
 *
 * Mocks:
 *   - `sessionVerifier.verifyToken` — controls the auth outcome.
 *   - `core-services-firebase` — stubs `userService` and `organizationService`.
 *   - `firebase-admin` — minimal mock so rate-limit middleware doesn't try
 *     to reach Firestore.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    userService: {
        getUserDataByUid: vi.fn(),
    },
    organizationService: {
        getUserOrganizations: vi.fn(),
    },
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
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
const { userService, organizationService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

function mkProfile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'viewer-uid',
        handle: 'viewer',
        displayName: 'Viewer',
        avatarUrl: 'https://example.com/v.jpg',
        bio: '',
        stats: { followers: 0, following: 0, prompts: 0 },
        badges: [],
        isVerified: false,
        createdAt: new Date().toISOString(),
        email: 'viewer@example.com',
        phoneNumber: '+15555550000',
        settings: { notifications: true },
        unreadReplyCount: 0,
        blockedUsers: [],
        reportCount: 0,
        isBanned: false,
        ...overrides,
    };
}

function asProfile(v: ReturnType<typeof mkProfile>) {
    return v as unknown as Awaited<ReturnType<typeof userService.getUserDataByUid>>;
}

describe('GET /api/v1/users/me', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s on missing Authorization header', async () => {
        const res = await app().request('/api/v1/users/me');
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Authentication required');
    });

    it('401s on invalid token', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockRejectedValue(new Error('bad token'));
        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer bogus' },
        });
        expect(res.status).toBe(401);
    });

    it('returns the full ProfileView (PII included) when authenticated', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(asProfile(mkProfile()));

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.handle).toBe('viewer');
        expect(body.email).toBe('viewer@example.com');
        expect(body.phoneNumber).toBe('+15555550000');
        expect(body.settings).toEqual({ notifications: true });
    });

    it('returns 404 if the profile does not exist for the viewer uid', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'orphan-uid' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Profile not found');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-2' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(
            asProfile(mkProfile({ id: 'viewer-uid-2', handle: 'v2' })),
        );

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token-2', 'x-request-id': 'trace-me' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-me');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-3' });
        vi.mocked(userService.getUserDataByUid).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token-3' },
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('GET /api/v1/users/me/organizations', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization header', async () => {
        const res = await app().request('/api/v1/users/me/organizations');
        expect(res.status).toBe(401);
    });

    it('returns hydrated orgs for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-org' });
        const fakeOrgs = [
            { record: { id: 'org-a', slug: 'alpha', name: 'Alpha' } },
            { record: { id: 'org-b', slug: 'beta', name: 'Beta' } },
        ];
        vi.mocked(organizationService.getUserOrganizations).mockResolvedValue(
            fakeOrgs as unknown as Awaited<ReturnType<typeof organizationService.getUserOrganizations>>,
        );

        const res = await app().request('/api/v1/users/me/organizations', {
            headers: { authorization: 'Bearer good-token-orgs' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: fakeOrgs });
        expect(vi.mocked(organizationService.getUserOrganizations)).toHaveBeenCalledWith('viewer-org');
    });

    it('returns an empty array when the viewer has no memberships', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'loner-uid' });
        vi.mocked(organizationService.getUserOrganizations).mockResolvedValue([]);

        const res = await app().request('/api/v1/users/me/organizations', {
            headers: { authorization: 'Bearer good-token-loner' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: [] });
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-boom' });
        vi.mocked(organizationService.getUserOrganizations).mockRejectedValue(new Error('boom'));

        const res = await app().request('/api/v1/users/me/organizations', {
            headers: { authorization: 'Bearer good-token-boom' },
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
