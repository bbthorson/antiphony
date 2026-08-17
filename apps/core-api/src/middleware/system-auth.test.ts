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

    // 32-char token used by the default beforeEach — meets the minimum
    // length requirement so tests verify auth logic, not the length guard.
    const VALID_TOKEN = 'test-secret-abcdef-1234567890abc'; // exactly 32 chars

    beforeEach(() => {
        process.env.SYSTEM_AUTH_TOKEN = VALID_TOKEN;
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
            headers: { authorization: `Bearer ${VALID_TOKEN}` },
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
            headers: { authorization: VALID_TOKEN },
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

    it('returns 503 (fail-closed) when SYSTEM_AUTH_TOKEN is shorter than 32 chars', async () => {
        // Short secrets don't meet the minimum entropy requirement; the
        // middleware should refuse all requests rather than silently accept.
        process.env.SYSTEM_AUTH_TOKEN = 'too-short'; // 9 chars < 32
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer too-short' },
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error.message).toMatch(/misconfigured/);
    });

    it('accepts a token that meets the 32-char minimum', async () => {
        // 32 chars exactly — should be accepted if it matches.
        process.env.SYSTEM_AUTH_TOKEN = 'a'.repeat(32);
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${'a'.repeat(32)}` },
        });
        expect(res.status).toBe(200);
    });

    it('rejects a token that is a prefix of the secret (constant-time guard)', async () => {
        // A prefix of VALID_TOKEN — must reject even though the prefix matches.
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${VALID_TOKEN.slice(0, -4)}` },
        });
        expect(res.status).toBe(401);
    });

    it('rejects a token that is longer than the secret', async () => {
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${VALID_TOKEN}-extra` },
        });
        expect(res.status).toBe(401);
    });

    // The stored secret is set by piping Secret Manager's output into
    // `wrangler secret put`, which carries the source value's trailing
    // newline into the env var. The length gate and the comparison must agree
    // about that whitespace: if only the gate trimmed, these would clear the
    // gate and then 401 on every request as a "token mismatch" — and the
    // stored value is write-only, so an operator couldn't tell that apart
    // from a genuinely wrong token.
    it('accepts the clean token when the stored secret has a trailing newline', async () => {
        process.env.SYSTEM_AUTH_TOKEN = `${VALID_TOKEN}\n`;
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${VALID_TOKEN}` },
        });
        expect(res.status).toBe(200);
    });

    it('accepts the clean token when the stored secret has surrounding spaces', async () => {
        process.env.SYSTEM_AUTH_TOKEN = `  ${VALID_TOKEN}  `;
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${VALID_TOKEN}` },
        });
        expect(res.status).toBe(200);
    });

    it('returns 503 when the secret only reaches 32 chars by counting whitespace', async () => {
        // 31 real chars + a newline. The length gate measures the trimmed
        // value, so this is too short — never a 32-char secret that then
        // fails to match.
        process.env.SYSTEM_AUTH_TOKEN = `${'a'.repeat(31)}\n`;
        const res = await makeApp().request('/protected', {
            headers: { authorization: `Bearer ${'a'.repeat(31)}` },
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error.message).toMatch(/misconfigured/);
    });

    it('returns 503 when the secret is only whitespace', async () => {
        process.env.SYSTEM_AUTH_TOKEN = '   \n';
        const res = await makeApp().request('/protected', {
            headers: { authorization: 'Bearer anything' },
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error.message).toMatch(/not configured/);
    });
});
