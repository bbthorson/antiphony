import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Tests for the auth middleware (`optionalAuth` + `requireAuth`).
 *
 * Mocks `sessionVerifier` so tests control the verify outcome without
 * touching Firebase. Fresh Hono app per test so handlers can assert on
 * `c.var.viewerUid` / `c.var.viewerSession` in isolation.
 */

const verifyToken = vi.fn();

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: {
        verifyToken: (token: string) => verifyToken(token),
    },
}));

// Silence logger.
process.env.LOG_LEVEL = 'silent';

const { optionalAuth, requireAuth } = await import('./auth.js');
const { requestId } = await import('./request-id.js');

/**
 * Build a fresh app wiring request-id + the middleware under test + a
 * capture handler that echoes viewer state back in the body. Keeps tests
 * decoupled from the full app stack.
 */
function makeApp(middleware: 'optional' | 'required') {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/probe', middleware === 'optional' ? optionalAuth() : requireAuth(), (c) => {
        return c.json({
            viewerUid: c.get('viewerUid'),
            viewerSessionUid: c.get('viewerSession')?.uid ?? null,
        });
    });
    return app;
}

describe('optionalAuth', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('treats a missing Authorization header as anonymous (viewerUid: null)', async () => {
        const res = await makeApp('optional').request('/probe');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ viewerUid: null, viewerSessionUid: null });
        expect(verifyToken).not.toHaveBeenCalled();
    });

    it('treats a malformed Authorization header (no Bearer prefix) as anonymous', async () => {
        const res = await makeApp('optional').request('/probe', {
            headers: { authorization: 'some-raw-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.viewerUid).toBeNull();
        expect(verifyToken).not.toHaveBeenCalled();
    });

    it('attaches viewerUid when the bearer token verifies', async () => {
        verifyToken.mockResolvedValue({ uid: 'u-123', email: 'alice@example.com' });

        const res = await makeApp('optional').request('/probe', {
            headers: { authorization: 'Bearer valid-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ viewerUid: 'u-123', viewerSessionUid: 'u-123' });
        expect(verifyToken).toHaveBeenCalledWith('valid-token');
    });

    it('treats an invalid token as anonymous (no 401)', async () => {
        verifyToken.mockRejectedValue(new Error('token expired'));

        const res = await makeApp('optional').request('/probe', {
            headers: { authorization: 'Bearer expired-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.viewerUid).toBeNull();
    });

    it('exposes the full verified session (custom claims) on viewerSession', async () => {
        verifyToken.mockResolvedValue({
            uid: 'u-999',
            currentOrg: 'org-abc',
            customRole: 'admin',
        });

        const app = new Hono();
        app.use('*', requestId());
        app.get('/probe', optionalAuth(), (c) => {
            const session = c.get('viewerSession');
            return c.json({
                uid: session?.uid ?? null,
                currentOrg: session?.currentOrg ?? null,
                customRole: session?.customRole ?? null,
            });
        });

        const res = await app.request('/probe', {
            headers: { authorization: 'Bearer x' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            uid: 'u-999',
            currentOrg: 'org-abc',
            customRole: 'admin',
        });
    });
});

describe('requireAuth', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns 401 when the Authorization header is missing', async () => {
        const res = await makeApp('required').request('/probe');

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Authentication required');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(verifyToken).not.toHaveBeenCalled();
    });

    it('returns 401 on a malformed Authorization header', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'some-raw-token' },
        });

        expect(res.status).toBe(401);
    });

    it('returns 401 on an invalid token', async () => {
        verifyToken.mockRejectedValue(new Error('token expired'));

        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'Bearer expired-token' },
        });

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Invalid or expired session');
    });

    it('passes through when the token verifies', async () => {
        verifyToken.mockResolvedValue({ uid: 'u-abc' });

        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ viewerUid: 'u-abc', viewerSessionUid: 'u-abc' });
    });

    it('trims whitespace in the bearer token', async () => {
        verifyToken.mockResolvedValue({ uid: 'u-def' });

        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'Bearer   padded-token   ' },
        });

        expect(res.status).toBe(200);
        expect(verifyToken).toHaveBeenCalledWith('padded-token');
    });
});
