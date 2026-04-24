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

describe('GET /health', () => {
    it('returns { ok: true }', async () => {
        const res = await app().request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});
