import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { requireSystemAuth } from './system-auth.js';
import { requestId } from './request-id.js';

/**
 * Tests for the shared-secret system-auth middleware. Built fresh per
 * test because the middleware reads `process.env.SYSTEM_AUTH_TOKEN` at
 * request time — each test sets/clears the env to keep cases isolated.
 */

process.env.LOG_LEVEL = 'silent';

function makeApp() {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/protected', requireSystemAuth(), (c) => c.json({ ok: true }));
    return app;
}

describe('requireSystemAuth', () => {
    const originalToken = process.env.SYSTEM_AUTH_TOKEN;

    beforeEach(() => {
        process.env.SYSTEM_AUTH_TOKEN = 'test-secret-abcdef';
    });

    afterEach(() => {
        if (originalToken === undefined) {
            delete process.env.SYSTEM_AUTH_TOKEN;
        } else {
            process.env.SYSTEM_AUTH_TOKEN = originalToken;
        }
    });

    it('returns 200 when the bearer matches SYSTEM_AUTH_TOKEN', async () => {
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer test-secret-abcdef' },
        });
        expect(res.status).toBe(200);
    });

    it('returns 401 when no authorization header', async () => {
        const res = await makeApp().request('/protected');
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.message).toMatch(/System authentication required/);
    });

    it('returns 401 when bearer token does not match', async () => {
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer wrong-secret' },
        });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.message).toMatch(/Invalid system credentials/);
    });

    it('returns 401 when authorization header is malformed (no Bearer prefix)', async () => {
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'test-secret-abcdef' },
        });
        expect(res.status).toBe(401);
    });

    it('returns 503 (fail-closed) when SYSTEM_AUTH_TOKEN env var is unset', async () => {
        delete process.env.SYSTEM_AUTH_TOKEN;
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer anything' },
        });
        expect(res.status).toBe(503);
    });

    it('returns 503 when SYSTEM_AUTH_TOKEN is empty string', async () => {
        process.env.SYSTEM_AUTH_TOKEN = '';
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer anything' },
        });
        expect(res.status).toBe(503);
    });

    it('rejects a token that is a prefix of the secret (constant-time guard)', async () => {
        // 'test-secret-abc' is a prefix of 'test-secret-abcdef' — must reject.
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer test-secret-abc' },
        });
        expect(res.status).toBe(401);
    });

    it('rejects a token that is longer than the secret', async () => {
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer test-secret-abcdef-extra' },
        });
        expect(res.status).toBe(401);
    });
});
