import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { base58btc } from 'multiformats/bases/base58';

/**
 * The auth middleware's signed-service-auth OBSERVATION, end to end.
 *
 * `signed-service-auth.test.ts` is the verifier's own subject — what a token
 * has to look like to pass. This file asserts the only property that makes it
 * safe to ship before anyone trusts it: **whatever the verifier concludes, the
 * response is unchanged.** A valid token, a forged one, a corrupt one and no
 * token at all must all produce exactly the response the bearer token earned.
 *
 * Uses the REAL app-did module (unlike `auth.test.ts`, which stubs it) because
 * the pin snapshot IS the keystore here — stubbing it would remove the thing
 * under test.
 */

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
const TENANT = 'voxpop';
const ISSUER = 'did:web:did.voxpop.audio';
const AUDIENCE = 'did:web:api.antiphony.dev';

process.env.ANTIPHONY_APP_TOKENS = `${TENANT}:${SERVICE_TOKEN}`;
process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev';
process.env.LOG_LEVEL = 'silent';

const { requireServiceToken } = await import('./auth.js');
const { requestId } = await import('./request-id.js');
const { errorHandler } = await import('./error-handler.js');
const { validateAllPins, resetValidatedPinsForTest } = await import('../lib/app-did.js');
const { logger } = await import('../lib/logger.js');

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encodeJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function multibaseFor(key: CryptoKey): Promise<string> {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const raw = (s: string) =>
        Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const x = raw(jwk.x!);
    const y = raw(jwk.y!);
    const prefixed = new Uint8Array(35);
    prefixed.set([0x80, 0x24], 0);
    prefixed[2] = (y[y.length - 1]! & 1) === 0 ? 0x02 : 0x03;
    prefixed.set(x, 3);
    return base58btc.encode(prefixed);
}

async function mint(
    privateKey: CryptoKey,
    claims: Record<string, unknown> = {},
): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = encodeJson({ alg: 'ES256', kid: '#atproto' });
    const p = encodeJson({
        iss: ISSUER,
        aud: AUDIENCE,
        iat: nowSec,
        exp: nowSec + 60,
        op: 'GET /probe',
        ...claims,
    });
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function makeApp() {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', requestId());
    app.get('/probe', requireServiceToken(), (c) =>
        c.json({ originAppId: c.get('originAppId') }),
    );
    return app;
}

const call = (headers: Record<string, string> = {}) =>
    makeApp().request('/probe', {
        headers: { authorization: `Bearer ${SERVICE_TOKEN}`, ...headers },
    });

let keyPair: CryptoKeyPair;

beforeEach(async () => {
    process.env.ANTIPHONY_APP_DIDS = `${TENANT}:${ISSUER}`;
    keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
    ])) as CryptoKeyPair;
    const multibase = await multibaseFor(keyPair.publicKey);
    await validateAllPins({
        raw: `${TENANT}:${ISSUER}`,
        fetchImpl: (async () => ({
            ok: true,
            json: async () => ({
                id: ISSUER,
                service: [
                    {
                        id: '#atproto_pds',
                        type: 'AtprotoPersonalDataServer',
                        serviceEndpoint: 'https://api.antiphony.dev',
                    },
                ],
                verificationMethod: [
                    {
                        id: `${ISSUER}#atproto`,
                        type: 'Multikey',
                        controller: ISSUER,
                        publicKeyMultibase: multibase,
                    },
                ],
            }),
        })) as unknown as typeof fetch,
    });
});

afterEach(() => {
    delete process.env.ANTIPHONY_APP_DIDS;
    resetValidatedPinsForTest();
    vi.restoreAllMocks();
});

describe('the response is identical regardless of what the verifier concludes', () => {
    it('passes with a valid signed token', async () => {
        const res = await call({ 'x-antiphony-service-auth': await mint(keyPair.privateKey) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ originAppId: TENANT });
    });

    it('passes with NO signed token — the header is optional today', async () => {
        const res = await call();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ originAppId: TENANT });
    });

    it('passes with a signed token that does not verify', async () => {
        const attacker = (await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
        )) as CryptoKeyPair;
        const res = await call({ 'x-antiphony-service-auth': await mint(attacker.privateKey) });
        expect(res.status).toBe(200);
    });

    it('passes with structural garbage in the header', async () => {
        for (const junk of ['', 'garbage', 'a.b.c', '....', 'Bearer nope']) {
            expect((await call({ 'x-antiphony-service-auth': junk })).status).toBe(200);
        }
    });

    it('passes with an expired token', async () => {
        const stale = Math.floor(Date.now() / 1000) - 3600;
        const res = await call({
            'x-antiphony-service-auth': await mint(keyPair.privateKey, {
                iat: stale,
                exp: stale + 60,
            }),
        });
        expect(res.status).toBe(200);
    });
});

describe('what it reports', () => {
    it('logs agreement when the token verifies and names the same tenant', async () => {
        const info = vi.spyOn(logger, 'info');
        await call({ 'x-antiphony-service-auth': await mint(keyPair.privateKey) });
        expect(info).toHaveBeenCalledWith(
            expect.objectContaining({ originAppId: TENANT, kid: '#atproto', enforced: false }),
            expect.stringContaining('verified and agrees'),
        );
    });

    it('warns, with a machine-countable reason, when a token fails to verify', async () => {
        const warn = vi.spyOn(logger, 'warn');
        await call({ 'x-antiphony-service-auth': await mint(keyPair.privateKey, { aud: 'https://api.antiphony.dev' }) });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'audience-mismatch', enforced: false }),
            expect.stringContaining('did NOT verify'),
        );
    });

    it('binds to the operation actually served, not the one the token names', async () => {
        const warn = vi.spyOn(logger, 'warn');
        await call({ 'x-antiphony-service-auth': await mint(keyPair.privateKey, { op: 'POST /api/v1/posts' }) });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'operation-mismatch' }),
            expect.anything(),
        );
    });

    it('escalates to error when a verified token names a DIFFERENT tenant than the bearer token', async () => {
        // Two tenants, each with its own pinned DID and key; the bearer token
        // is `voxpop`'s, the signed token is the other's. This is the one
        // outcome that must stop the rollout, so it must not read as a warning.
        const otherDid = 'did:web:did.other.example';
        const other = (await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
        )) as CryptoKeyPair;
        const otherMultibase = await multibaseFor(other.publicKey);
        process.env.ANTIPHONY_APP_DIDS = `${TENANT}:${ISSUER},other:${otherDid}`;
        await validateAllPins({
            raw: process.env.ANTIPHONY_APP_DIDS,
            fetchImpl: (async (url: string) => {
                const host = new URL(url).host;
                const isOther = host === 'did.other.example';
                return {
                    ok: true,
                    json: async () => ({
                        id: `did:web:${host}`,
                        service: [
                            {
                                id: '#atproto_pds',
                                type: 'AtprotoPersonalDataServer',
                                serviceEndpoint: 'https://api.antiphony.dev',
                            },
                        ],
                        verificationMethod: [
                            {
                                id: `did:web:${host}#atproto`,
                                type: 'Multikey',
                                controller: `did:web:${host}`,
                                publicKeyMultibase: isOther
                                    ? otherMultibase
                                    : await multibaseFor(keyPair.publicKey),
                            },
                        ],
                    }),
                };
            }) as unknown as typeof fetch,
        });

        const error = vi.spyOn(logger, 'error');
        const res = await call({
            'x-antiphony-service-auth': await mint(other.privateKey, { iss: otherDid }),
        });

        // Still a 200 — observation only, even for the worst outcome.
        expect(res.status).toBe(200);
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({ originAppId: TENANT, tokenOriginAppId: 'other' }),
            expect.stringContaining('DISAGREEMENT'),
        );
    });
});
