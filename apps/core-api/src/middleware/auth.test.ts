import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

/**
 * Tests for the auth middleware (`requireServiceToken` + `requireAuth`).
 *
 * The service token is the only accepted credential and every data route is
 * gated — there is no tokenless path (specs/core-surface.md). Tests configure
 * `ANTIPHONY_APP_TOKENS` and drive requests with a `Bearer <service-token>`
 * header plus the `X-Antiphony-Acting-Actor` assertion. Fresh Hono app per test
 * so handlers can assert on `c.var` in isolation.
 */

// A configured service token (≥32 chars) for the fake app `test-app`.
const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;
process.env.LOG_LEVEL = 'silent';

const { requireServiceToken, requireAuth, ACTING_ACTOR_HEADER, ACTING_ACTOR_DID_HEADER } =
    await import('./auth.js');
const { requestId } = await import('./request-id.js');

/**
 * Build a fresh app wiring request-id + the middleware under test + a
 * capture handler that echoes viewer state back in the body. Keeps tests
 * decoupled from the full app stack.
 */
function makeApp(middleware: 'service' | 'required') {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/probe', middleware === 'service' ? requireServiceToken() : requireAuth(), (c) => {
        return c.json({
            viewerUid: c.get('viewerUid'),
            originAppId: c.get('originAppId'),
            actingActorDid: c.get('actingActorDid'),
        });
    });
    return app;
}

/** Headers for an authenticated service call asserting `actor`. */
function svc(actor?: string, did?: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${SERVICE_TOKEN}` };
    if (actor !== undefined) headers[ACTING_ACTOR_HEADER] = actor;
    if (did !== undefined) headers[ACTING_ACTOR_DID_HEADER] = did;
    return headers;
}

describe('requireServiceToken', () => {
    it('returns 401 when the Authorization header is missing', async () => {
        const res = await makeApp('service').request('/probe');

        expect(res.status).toBe(401);
        expect((await res.json()).error.message).toBe('Authentication required');
    });

    it('returns 401 on a malformed Authorization header (no Bearer prefix)', async () => {
        const res = await makeApp('service').request('/probe', {
            headers: { authorization: 'some-raw-token' },
        });

        expect(res.status).toBe(401);
    });

    it('returns 401 on a token that is not a recognized service token', async () => {
        const res = await makeApp('service').request('/probe', {
            headers: { authorization: 'Bearer not-a-configured-token' },
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error.message).toBe('Invalid service token');
    });

    it('decorates the context on a valid service token + acting-actor', async () => {
        const res = await makeApp('service').request('/probe', {
            headers: svc('actor-1', 'did:web:voxpop.audio'),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            viewerUid: 'actor-1',
            originAppId: 'test-app',
            actingActorDid: 'did:web:voxpop.audio',
        });
    });

    it('allows an anonymous read: valid token, no acting-actor (viewerUid null, tenancy set)', async () => {
        const res = await makeApp('service').request('/probe', {
            headers: svc(),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            viewerUid: null,
            originAppId: 'test-app',
            actingActorDid: null,
        });
    });

    it('ignores a DID assertion when no acting-actor is present', async () => {
        const res = await makeApp('service').request('/probe', {
            headers: svc(undefined, 'did:web:voxpop.audio'),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).actingActorDid).toBeNull();
    });
});

describe('requireAuth', () => {
    it('returns 401 when the Authorization header is missing', async () => {
        const res = await makeApp('required').request('/probe');

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Authentication required');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns 401 on a malformed Authorization header', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'some-raw-token' },
        });

        expect(res.status).toBe(401);
    });

    it('returns 401 on a token that is not a recognized service token', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'Bearer not-a-configured-token' },
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error.message).toBe('Invalid service token');
    });

    it('returns 401 when the service token is valid but no acting-actor is asserted', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: svc(),
        });

        expect(res.status).toBe(401);
        expect((await res.json()).error.message).toBe(
            'X-Antiphony-Acting-Actor header required for this endpoint',
        );
    });

    it('passes through on a valid service token + acting-actor', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: svc('actor-abc'),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            viewerUid: 'actor-abc',
            originAppId: 'test-app',
            actingActorDid: null,
        });
    });
});
