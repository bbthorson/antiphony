import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/atproto/disconnect`.
 *
 * `requireAuth()`-gated: anonymous → 401, valid token → calls
 * `userService.disconnectAtproto(uid)`. Service errors propagate to a
 * 500 with requestId.
 *
 * Mocks:
 *   - `sessionVerifier.verifyToken` — controls the auth outcome.
 *   - `core-services-firebase` — stubs `userService.disconnectAtproto`.
 *   - `firebase-admin` — minimal mock so rate-limit middleware doesn't
 *     try to reach Firestore.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        disconnectAtproto: vi.fn(),
    },
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({
            doc: () => ({
                get: async () => ({ exists: false }),
                update: async () => undefined,
            }),
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
const { userService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

describe('POST /api/v1/atproto/disconnect', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s on missing Authorization header', async () => {
        const res = await app().request('/api/v1/atproto/disconnect', { method: 'POST' });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Authentication required');
    });

    it('401s on invalid token', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockRejectedValue(new Error('bad token'));
        const res = await app().request('/api/v1/atproto/disconnect', {
            method: 'POST',
            headers: { authorization: 'Bearer bogus' },
        });
        expect(res.status).toBe(401);
    });

    it('removes the AT Proto identity and returns success envelope', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid' });
        vi.mocked(userService.disconnectAtproto).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/atproto/disconnect', {
            method: 'POST',
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(200);
        expect(vi.mocked(userService.disconnectAtproto)).toHaveBeenCalledWith('viewer-uid');
        const body = await res.json();
        expect(body).toEqual({ success: true, data: null });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-2' });
        vi.mocked(userService.disconnectAtproto).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/atproto/disconnect', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'x-request-id': 'trace-me' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-me');
    });

    it('maps service errors to 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-3' });
        vi.mocked(userService.disconnectAtproto).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/atproto/disconnect', {
            method: 'POST',
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
