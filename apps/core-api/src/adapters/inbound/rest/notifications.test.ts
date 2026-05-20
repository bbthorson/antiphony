import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `/api/v1/notifications/{register,disable}-token`. Parity
 * ports of the apps/web routes (deleted in PR-F3a). Both auth-required;
 * both per-viewer; both idempotent at the Firestore layer
 * (arrayUnion / arrayRemove).
 */

vi.mock('../../../lib/fcm-token-store.js', () => ({
    registerFcmToken: vi.fn(),
    disableFcmToken: vi.fn(),
}));

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {},
    userService: {},
    organizationService: {},
    promptService: {},
    hydrationService: {},
    replyService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { registerFcmToken, disableFcmToken } = await import('../../../lib/fcm-token-store.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

const VALID_TOKEN = 'a'.repeat(140); // Real FCM tokens are ~150 chars

describe('POST /api/v1/notifications/register-token', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('registers the token for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(registerFcmToken).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/notifications/register-token', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(registerFcmToken).toHaveBeenCalledWith('u-self', VALID_TOKEN);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/notifications/register-token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        });
        expect(res.status).toBe(401);
        expect(registerFcmToken).not.toHaveBeenCalled();
    });

    it('400s on invalid JSON', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/notifications/register-token', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: 'not json',
        });
        expect(res.status).toBe(400);
        expect(registerFcmToken).not.toHaveBeenCalled();
    });

    it('400s when token is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/notifications/register-token', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        expect(registerFcmToken).not.toHaveBeenCalled();
    });
});

describe('POST /api/v1/notifications/disable-token', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('disables the token for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(disableFcmToken).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/notifications/disable-token', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(disableFcmToken).toHaveBeenCalledWith('u-self', VALID_TOKEN);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/notifications/disable-token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: VALID_TOKEN }),
        });
        expect(res.status).toBe(401);
        expect(disableFcmToken).not.toHaveBeenCalled();
    });

    it('400s when token is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/notifications/disable-token', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        expect(disableFcmToken).not.toHaveBeenCalled();
    });
});
