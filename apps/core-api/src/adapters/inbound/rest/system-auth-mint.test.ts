import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/system/auth/mint-session-cookie`.
 *
 * System-auth-gated: missing/invalid bearer → 401. With valid bearer:
 *   - 200 + sessionCookie when adminAuth.createSessionCookie succeeds.
 *   - 400 INVALID_ID_TOKEN when Firebase rejects the ID token (any
 *     `code` starting with `auth/`).
 *   - 500 (via the error handler) on unexpected exceptions.
 */

const createSessionCookie = vi.fn();

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({ doc: () => ({}) }),
    }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({
        createSessionCookie: (idToken: string, opts: { expiresIn: number }) =>
            createSessionCookie(idToken, opts),
    }),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';
// 32-char token — meets the minimum length requirement enforced by system-auth
// middleware (L1 security hardening). Tests that verify auth rejection use a
// different or missing bearer, not a short configured token.
process.env.SYSTEM_AUTH_TOKEN = 'test-system-token-abcdef-1234567'; // 32 chars

const { app } = await import('../../../app.js');

const withSystemAuth = (extra: Record<string, string> = {}) => ({
    authorization: 'Bearer test-system-token-abcdef-1234567',
    'content-type': 'application/json',
    ...extra,
});

const validBody = JSON.stringify({
    idToken: 'fake-id-token',
    expiresInMs: 5 * 24 * 60 * 60 * 1000, // 5 days, matches apps/web default
});

describe('POST /api/v1/system/auth/mint-session-cookie', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without system-auth', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: validBody,
        });
        expect(res.status).toBe(401);
    });

    it('401s with wrong bearer', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
            body: validBody,
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid JSON body', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: 'not json',
        });
        expect(res.status).toBe(400);
    });

    it('400s when idToken is missing', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: JSON.stringify({ expiresInMs: 60 * 60 * 1000 }),
        });
        expect(res.status).toBe(400);
    });

    it('400s when expiresInMs is below Firebase minimum (5 minutes)', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: JSON.stringify({ idToken: 'tok', expiresInMs: 60 * 1000 }),
        });
        expect(res.status).toBe(400);
    });

    it('400s when expiresInMs exceeds Firebase maximum (14 days)', async () => {
        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: JSON.stringify({ idToken: 'tok', expiresInMs: 15 * 24 * 60 * 60 * 1000 }),
        });
        expect(res.status).toBe(400);
    });

    it('returns the minted sessionCookie on success', async () => {
        createSessionCookie.mockResolvedValueOnce('signed-session-cookie-value');

        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.sessionCookie).toBe('signed-session-cookie-value');
        expect(createSessionCookie).toHaveBeenCalledWith('fake-id-token', {
            expiresIn: 5 * 24 * 60 * 60 * 1000,
        });
    });

    it('maps Firebase auth/* errors to 400 INVALID_ID_TOKEN', async () => {
        const fbErr = Object.assign(new Error('Firebase ID token has expired.'), {
            code: 'auth/id-token-expired',
        });
        createSessionCookie.mockRejectedValueOnce(fbErr);

        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('INVALID_ID_TOKEN');
    });

    it('passes unexpected errors through to the error handler as 500', async () => {
        // Non-`auth/*` code → not a Firebase rejection of the token; the
        // route handler rethrows and the error handler maps to 500.
        createSessionCookie.mockRejectedValueOnce(new Error('admin SDK offline'));

        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates the inbound X-Request-ID header', async () => {
        createSessionCookie.mockResolvedValueOnce('cookie-value');

        const res = await app().request('/api/v1/system/auth/mint-session-cookie', {
            method: 'POST',
            headers: withSystemAuth({ 'x-request-id': 'trace-me' }),
            body: validBody,
        });

        expect(res.headers.get('x-request-id')).toBe('trace-me');
    });
});
