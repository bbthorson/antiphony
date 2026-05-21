import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/users/:handle`.
 *
 * Pre-bearer-bridge scope: viewer is always null, so `isSelf` is always
 * false and every response goes through `toProfileViewBasic`. These tests
 * cover that anonymous path.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        getUserData: vi.fn(),
    },
    promptService: {},
    organizationService: {},
    hydrationService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

// Snapshot returned by the firestore query chain (used by GET /api/v1/users).
// Tests mutate this between cases; reset in beforeEach.
const mockUserDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

vi.mock('../../../lib/firebase-admin.js', () => {
    // Chainable query proxy — every query method returns `query` itself,
    // so any combination of where/orderBy/limit/startAfter resolves to .get().
    const query = {
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        startAfter: () => query,
        get: async () => ({ docs: mockUserDocs }),
        doc: () => ({}),
    };
    return {
        getAdminDb: () => ({
            collection: () => query,
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
    };
});

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { userService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

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

    it('returns the FULL profile (PII + settings) when viewer is the target user', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(userService.getUserData).mockResolvedValue(asProfile(mkProfile()));

        const res = await app().request('/api/v1/users/alice', {
            headers: { authorization: 'Bearer self-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        // PII + admin fields present (not stripped) — full view.
        expect(body.data.email).toBe('leak@example.com');
        expect(body.data.phoneNumber).toBe('+15555550123');
        expect(body.data.settings).toEqual({ notifications: true });
        expect(body.data.unreadReplyCount).toBe(5);
    });

    it('strips PII when viewer is authenticated but NOT self', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'other-user' });
        vi.mocked(userService.getUserData).mockResolvedValue(asProfile(mkProfile()));

        const res = await app().request('/api/v1/users/alice', {
            headers: { authorization: 'Bearer other-token' },
        });

        const body = await res.json();
        expect(body.data.email).toBeUndefined();
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

describe('GET /api/v1/users (public discovery list)', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockUserDocs.length = 0;
    });

    it('returns an empty list + null cursor when no users exist', async () => {
        const res = await app().request('/api/v1/users');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.items).toEqual([]);
        expect(body.data.nextCursor).toBeNull();
    });

    it('returns parsed users (page not full → no nextCursor)', async () => {
        mockUserDocs.push(
            {
                id: 'u-a',
                data: () => ({
                    handle: 'alice-pub',
                    displayName: 'Alice',
                    avatarUrl: 'https://x/a.jpg',
                    bio: 'hi',
                }),
            },
            {
                id: 'u-b',
                data: () => ({
                    handle: 'bob-pub',
                    displayName: 'Bob',
                    avatarUrl: null,
                    bio: null,
                }),
            },
        );

        const res = await app().request('/api/v1/users?limit=10');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.items).toHaveLength(2);
        expect(body.data.items[0].handle).toBe('alice-pub');
        expect(body.data.items[1].handle).toBe('bob-pub');
        expect(body.data.nextCursor).toBeNull();
    });

    it('returns nextCursor (last handle) when the page is full', async () => {
        // limit=2 → fetch 3, return 2, signal hasMore via the third's handle.
        mockUserDocs.push(
            {
                id: 'u-1',
                data: () => ({ handle: 'h-1', displayName: 'A', avatarUrl: null, bio: null }),
            },
            {
                id: 'u-2',
                data: () => ({ handle: 'h-2', displayName: 'B', avatarUrl: null, bio: null }),
            },
            {
                id: 'u-3',
                data: () => ({ handle: 'h-3', displayName: 'C', avatarUrl: null, bio: null }),
            },
        );

        const res = await app().request('/api/v1/users?limit=2');

        const body = await res.json();
        expect(body.data.items).toHaveLength(2);
        // Last returned doc's handle is the cursor — the +1 fetched doc is dropped.
        expect(body.data.nextCursor).toBe('h-2');
    });

    it('falls back to a minimal projection when PublicProfileDtoSchema parse fails', async () => {
        // ProfileViewBasicSchema accepts `handle: z.string().nullable().optional()`
        // but rejects a number — forces parse failure → exercises the fallback.
        // The fallback uses String(...) coercion so non-string Firestore data
        // (e.g. a numeric handle) is converted to a safe string, not passed
        // through unchanged.
        mockUserDocs.push({
            id: 'u-broken',
            data: () => ({ handle: 12345 as unknown as string }),
        });

        const res = await app().request('/api/v1/users?limit=10');

        const body = await res.json();
        // Fallback coerces handle/displayName to strings (Gemini #364 fix).
        expect(body.data.items[0].handle).toBe('12345');
        expect(body.data.items[0].displayName).toBe('12345');
        expect(body.data.items[0].avatarUrl).toBeNull();
        expect(body.data.items[0].bio).toBeNull();
    });

    it('400s on invalid limit (non-numeric)', async () => {
        const res = await app().request('/api/v1/users?limit=banana');

        expect(res.status).toBe(400);
    });
});
