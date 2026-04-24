import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/handles`.
 *
 * The route handler goes through:
 *   request-id middleware → rate-limit middleware → route → error-handler
 *
 * Mocks:
 *   - `firebase-admin` isn't initialized during test — the rate-limit
 *     middleware short-circuits via the circuit breaker when Firestore
 *     writes fail. That's fine for our test surface because we're not
 *     exercising the rate-limit code path; the handler itself is what
 *     matters. We mock `core-services-firebase` to control what
 *     `userService.getAllPublicHandles` returns.
 */

// Mock the wired service singleton BEFORE importing the app factory so
// the module graph resolves our stub rather than trying to contact Firebase.
vi.mock('../services/core-services-firebase.js', () => ({
    userService: {
        getAllPublicHandles: vi.fn(),
    },
    firebaseCoreServices: {},
}));

vi.mock('../services/users-dependencies.js', () => ({
    firebaseUserDependencies: {
        resolveHandle: vi.fn(),
    },
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

// Mock firebase-admin so the rate-limit middleware can't reach real Firestore.
// We make the rate-limit's runTransaction return `false` (not limited) so the
// middleware lets the request through.
vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({
            doc: () => ({}),
        }),
        runTransaction: async (fn: (t: unknown) => Promise<boolean>) => fn({ get: async () => ({ exists: false, data: () => undefined }), set: () => undefined, update: () => undefined }),
    }),
    getAdmin: () => ({
        firestore: {
            Timestamp: {
                fromMillis: (ms: number) => ({ _ms: ms }),
            },
        },
    }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

// Silence pino during tests.
process.env.LOG_LEVEL = 'silent';

const { app } = await import('../app.js');
const { userService } = await import('../services/core-services-firebase.js');
const { firebaseUserDependencies } = await import('../services/users-dependencies.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

describe('GET /api/v1/handles', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the list of public handles as { success: true, data: [] }', async () => {
        vi.mocked(userService.getAllPublicHandles).mockResolvedValue(['alice', 'bob', 'charlie']);

        const res = await app().request('/api/v1/handles');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            success: true,
            data: ['alice', 'bob', 'charlie'],
        });
    });

    it('stamps X-Request-ID on the response', async () => {
        vi.mocked(userService.getAllPublicHandles).mockResolvedValue([]);

        const res = await app().request('/api/v1/handles');

        expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates an inbound X-Request-ID header', async () => {
        vi.mocked(userService.getAllPublicHandles).mockResolvedValue([]);

        const res = await app().request('/api/v1/handles', {
            headers: { 'x-request-id': 'upstream-correlation-abc' },
        });

        expect(res.headers.get('x-request-id')).toBe('upstream-correlation-abc');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(userService.getAllPublicHandles).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/handles');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Internal Server Error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('GET /api/v1/handles/check', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s when no Authorization header is sent', async () => {
        const res = await app().request('/api/v1/handles/check?handle=alice');
        expect(res.status).toBe(401);
    });

    it('flags invalid handles (too short, bad chars) without touching Firestore', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-1' });

        const res = await app().request('/api/v1/handles/check?handle=no', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ available: false, reason: 'invalid' });
        expect(vi.mocked(firebaseUserDependencies.resolveHandle)).not.toHaveBeenCalled();
    });

    it('returns `{available: true}` when the handle resolves to no uid', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-2' });
        vi.mocked(firebaseUserDependencies.resolveHandle).mockResolvedValue(null);

        const res = await app().request('/api/v1/handles/check?handle=freshname', {
            headers: { authorization: 'Bearer good-2' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ available: true });
    });

    it('returns `{available: true, owned: true}` when the handle belongs to the viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-3' });
        vi.mocked(firebaseUserDependencies.resolveHandle).mockResolvedValue('viewer-3');

        const res = await app().request('/api/v1/handles/check?handle=myname', {
            headers: { authorization: 'Bearer good-3' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ available: true, owned: true });
    });

    it('returns `{available: false, reason: taken}` when owned by someone else', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-4' });
        vi.mocked(firebaseUserDependencies.resolveHandle).mockResolvedValue('someone-else');

        const res = await app().request('/api/v1/handles/check?handle=populer', {
            headers: { authorization: 'Bearer good-4' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ available: false, reason: 'taken' });
    });

    it('lower-cases the input before lookup (query param "Alice" → "alice")', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-5' });
        vi.mocked(firebaseUserDependencies.resolveHandle).mockResolvedValue(null);

        const res = await app().request('/api/v1/handles/check?handle=CaseyCase', {
            headers: { authorization: 'Bearer good-5' },
        });

        expect(res.status).toBe(200);
        expect(vi.mocked(firebaseUserDependencies.resolveHandle)).toHaveBeenCalledWith('caseycase');
    });
});

describe('GET /health', () => {
    it('returns { ok: true }', async () => {
        const res = await app().request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});
