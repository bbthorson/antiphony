import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Tests for the service-to-service auth path (`specs/service-auth.md`):
 * `parseAppTokens` config parsing + the service branch inside
 * `optionalAuth`/`requireAuth` (tenancy from credential, acting-actor
 * assertion). The service token is the only accepted credential — a
 * non-matching token is rejected, never verified as an end-user token.
 */

process.env.LOG_LEVEL = 'silent';

const { parseAppTokens } = await import('./service-auth.js');
const { optionalAuth, requireAuth } = await import('./auth.js');
const { requestId } = await import('./request-id.js');
const { getOriginAppId } = await import('../lib/origin-app.js');

const TOKEN = 'a'.repeat(32) + '-vox-pop-service-token';

function makeApp(middleware: 'optional' | 'required') {
    const app = new Hono();
    app.use('*', requestId());
    app.get('/probe', middleware === 'optional' ? optionalAuth() : requireAuth(), (c) => {
        return c.json({
            viewerUid: c.get('viewerUid'),
            originAppId: c.get('originAppId'),
            actingActorDid: c.get('actingActorDid'),
            resolvedOrigin: getOriginAppId(c),
        });
    });
    return app;
}

describe('parseAppTokens', () => {
    it('parses appId:token pairs, trimming whitespace', () => {
        const apps = parseAppTokens(` vox-pop:${TOKEN} , bardcast:${'b'.repeat(40)} `);
        expect(apps).toEqual([
            { appId: 'vox-pop', token: TOKEN },
            { appId: 'bardcast', token: 'b'.repeat(40) },
        ]);
    });

    it('returns [] for unset/empty config', () => {
        expect(parseAppTokens(undefined)).toEqual([]);
        expect(parseAppTokens('  ')).toEqual([]);
    });

    it('drops malformed entries and short tokens (fail-closed)', () => {
        expect(parseAppTokens('no-separator')).toEqual([]);
        expect(parseAppTokens(':orphan-token')).toEqual([]);
        expect(parseAppTokens('vox-pop:short')).toEqual([]);
    });

    it('allows one app id twice (rotation window)', () => {
        const apps = parseAppTokens(`vox-pop:${'x'.repeat(32)},vox-pop:${'y'.repeat(32)}`);
        expect(apps).toHaveLength(2);
        expect(apps.every((a) => a.appId === 'vox-pop')).toBe(true);
    });
});

describe('service-token auth path', () => {
    beforeEach(() => {
        process.env.ANTIPHONY_APP_TOKENS = `vox-pop:${TOKEN}`;
    });
    afterEach(() => {
        delete process.env.ANTIPHONY_APP_TOKENS;
    });

    it('derives originAppId from the credential and the actor from the assertion header', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-42',
                'x-antiphony-acting-actor-did': 'did:plc:abc',
            },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            viewerUid: 'user-42',
            originAppId: 'vox-pop',
            actingActorDid: 'did:plc:abc',
            resolvedOrigin: 'vox-pop',
        });
    });

    it('401s on requireAuth when the app omits the acting-actor header', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.message).toContain('X-Antiphony-Acting-Actor');
    });

    it('optionalAuth allows an anonymous tenancy-scoped read (token, no actor)', async () => {
        const res = await makeApp('optional').request('/probe', {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            viewerUid: null,
            originAppId: 'vox-pop',
            actingActorDid: null,
            resolvedOrigin: 'vox-pop',
        });
    });

    it('ignores a DID assertion without an actor', async () => {
        const res = await makeApp('optional').request('/probe', {
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor-did': 'did:plc:abc',
            },
        });
        expect((await res.json()).actingActorDid).toBeNull();
    });

    it('rejects a non-matching token with 401 on requireAuth (no end-user fallback)', async () => {
        const res = await makeApp('required').request('/probe', {
            headers: { authorization: 'Bearer some-non-service-token' },
        });
        expect(res.status).toBe(401);
        expect((await res.json()).error.message).toBe('Invalid service token');
    });

    it('treats a non-matching token as anonymous on optionalAuth', async () => {
        const res = await makeApp('optional').request('/probe', {
            headers: { authorization: 'Bearer some-non-service-token' },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.viewerUid).toBeNull();
        // Anonymous read: no credential tenancy, so it falls back to the env default.
        expect(body.originAppId).toBeNull();
        expect(body.resolvedOrigin).toBe('antiphony');
    });

    it('does not honor acting-actor headers without a valid service token', async () => {
        const res = await makeApp('optional').request('/probe', {
            headers: {
                authorization: 'Bearer some-non-service-token',
                'x-antiphony-acting-actor': 'spoofed-actor',
                'x-antiphony-acting-actor-did': 'did:plc:spoof',
            },
        });
        const body = await res.json();
        expect(body.viewerUid).toBeNull();
        expect(body.actingActorDid).toBeNull();
    });
});
