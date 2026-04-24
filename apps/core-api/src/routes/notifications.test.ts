import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for FCM token register + disable endpoints.
 */

const fcmSet = vi.fn();

vi.mock('../services/core-services-firebase.js', () => ({
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
        collection: () => ({
            doc: () => ({
                collection: () => ({
                    doc: () => ({
                        set: (patch: unknown, opts: unknown) => fcmSet(patch, opts),
                    }),
                }),
            }),
        }),
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
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

const bearerPost = (path: string, body: unknown) =>
    app().request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
        body: JSON.stringify(body),
    });

describe('POST /api/v1/notifications/register-token', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        fcmSet.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/notifications/register-token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'fcm-x' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s when token is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await bearerPost('/api/v1/notifications/register-token', {});
        expect(res.status).toBe(400);
    });

    it('writes arrayUnion on register', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-2' });
        const res = await bearerPost('/api/v1/notifications/register-token', {
            token: 'fcm-abc',
        });
        expect(res.status).toBe(200);
        expect(fcmSet).toHaveBeenCalledWith(
            { tokens: expect.any(Object) },
            { merge: true },
        );
    });
});

describe('POST /api/v1/notifications/disable-token', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        fcmSet.mockReset();
    });

    it('writes arrayRemove on disable', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-3' });
        const res = await bearerPost('/api/v1/notifications/disable-token', {
            token: 'fcm-stale',
        });
        expect(res.status).toBe(200);
        expect(fcmSet).toHaveBeenCalledWith(
            { tokens: expect.any(Object) },
            { merge: true },
        );
    });
});
