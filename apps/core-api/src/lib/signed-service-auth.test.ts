import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { base58btc } from 'multiformats/bases/base58';
import { validateAllPins, resetValidatedPinsForTest } from './app-did.js';
import {
    verifySignedServiceAuth,
    verificationMethodByKid,
    importMultikeyP256,
    requestOperation,
    type SignedServiceAuthClaims,
} from './signed-service-auth.js';

const TENANT = 'voxpop';
const ISSUER = 'did:web:did.voxpop.audio';
const AUDIENCE = 'did:web:api.antiphony.dev';

/**
 * The key Vox Pop actually publishes, and the JWK its running BFF actually
 * serves at `/health` — both captured 2026-08-21.
 *
 * Hard-coded rather than fetched: a unit test that reaches the network fails
 * for reasons that have nothing to do with the code under test. What this pair
 * pins is the DECODE — that our multibase → SPKI → import path lands on the
 * same point the signer holds. If Vox Pop rotates, this fixture is stale and
 * the honest fix is to re-capture it, not to loosen the assertion.
 */
const LIVE_MULTIBASE = 'zDnaeUpyKYkJyToZtGeR5eiFvUqK3DNJM498vTN2oryWERffV';
const LIVE_JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: 'QVNqpit0w9F7SMEuiXDIAdAHTITEuKuPzkMsit3xaUA',
    y: 'uJQa7Zvlwb0S5RIwaqSkuKAnyjH6DlOzFgL-wNUQEtI',
} as const;

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encodeJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

/** Compress a P-256 public key to the 33-byte SEC1 form, then multibase it. */
async function multibaseFor(key: CryptoKey): Promise<string> {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const raw = (s: string) => {
        const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(b, (c) => c.charCodeAt(0));
    };
    const x = raw(jwk.x!);
    const y = raw(jwk.y!);
    const point = new Uint8Array(33);
    point[0] = (y[y.length - 1]! & 1) === 0 ? 0x02 : 0x03;
    point.set(x, 1);
    const prefixed = new Uint8Array(35);
    prefixed.set([0x80, 0x24], 0);
    prefixed.set(point, 2);
    return base58btc.encode(prefixed);
}

/** Mint a real ES256 compact JWS, the way the Vox Pop signer does. */
async function mint(
    privateKey: CryptoKey,
    claims: Partial<SignedServiceAuthClaims> & Record<string, unknown> = {},
    header: Record<string, unknown> = {},
): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
        iss: ISSUER,
        aud: AUDIENCE,
        iat: nowSec,
        exp: nowSec + 60,
        op: 'POST /api/v1/posts',
        ...claims,
    };
    const h = encodeJson({ alg: 'ES256', kid: '#atproto', ...header });
    const p = encodeJson(payload);
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

/** Seed the pin snapshot with a DID document carrying `methods`. */
async function seedPin(methods: unknown[]): Promise<void> {
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
                verificationMethod: methods,
            }),
        })) as unknown as typeof fetch,
    });
}

let keyPair: CryptoKeyPair;
const verify = (token: string, over = {}) =>
    verifySignedServiceAuth(token, {
        expectedAudience: AUDIENCE,
        operation: requestOperation('POST', '/api/v1/posts'),
        ...over,
    });

beforeEach(async () => {
    process.env.ANTIPHONY_APP_DIDS = `${TENANT}:${ISSUER}`;
    keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
    ])) as CryptoKeyPair;
    await seedPin([
        {
            id: `${ISSUER}#atproto`,
            type: 'Multikey',
            controller: ISSUER,
            publicKeyMultibase: await multibaseFor(keyPair.publicKey),
        },
    ]);
});

afterEach(() => {
    delete process.env.ANTIPHONY_APP_DIDS;
    resetValidatedPinsForTest();
});

describe('importMultikeyP256 — the decode, against the live published key', () => {
    it('lands on exactly the point the Vox Pop BFF holds', async () => {
        const key = await importMultikeyP256(LIVE_MULTIBASE);
        expect(key).not.toBeNull();
        // Re-import as extractable to read the coordinates back out; the
        // production path imports non-extractable, which cannot be exported.
        const spkiKey = await importMultikeyP256(LIVE_MULTIBASE);
        expect(spkiKey?.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });

        // The decode itself, reproduced independently of the import.
        const decoded = base58btc.decode(LIVE_MULTIBASE);
        expect(decoded.length).toBe(35);
        expect([decoded[0], decoded[1]]).toEqual([0x80, 0x24]);
        expect(decoded[2]).toBe(0x02); // even y

        const x = decoded.subarray(3);
        const expectedX = Uint8Array.from(
            atob(LIVE_JWK.x.replace(/-/g, '+').replace(/_/g, '/')),
            (c) => c.charCodeAt(0),
        );
        expect(Array.from(x)).toEqual(Array.from(expectedX));
    });

    it('rejects a point that is not on the curve', async () => {
        const bogus = new Uint8Array(35);
        bogus.set([0x80, 0x24], 0);
        bogus[2] = 0x02;
        bogus.fill(0xff, 3);
        expect(await importMultikeyP256(base58btc.encode(bogus))).toBeNull();
    });

    it('rejects a non-P-256 multicodec', async () => {
        const ed = new Uint8Array(35);
        ed.set([0xed, 0x01], 0); // ed25519-pub
        expect(await importMultikeyP256(base58btc.encode(ed))).toBeNull();
    });

    it('rejects a non-multibase string', async () => {
        expect(await importMultikeyP256('not-multibase')).toBeNull();
    });
});

describe('verificationMethodByKid', () => {
    const vm = (frag: string) => ({ id: `${ISSUER}#${frag}`, type: 'Multikey', publicKeyMultibase: 'z1' });

    it('selects by fragment across a multi-entry array (rotation window)', () => {
        const doc = { verificationMethod: [vm('old'), vm('atproto'), vm('next')] };
        expect(verificationMethodByKid(doc, '#atproto')?.id).toBe(`${ISSUER}#atproto`);
        expect(verificationMethodByKid(doc, 'atproto')?.id).toBe(`${ISSUER}#atproto`);
        expect(verificationMethodByKid(doc, '#next')?.id).toBe(`${ISSUER}#next`);
    });

    it('does not fall back to the only entry when the kid misses', () => {
        expect(verificationMethodByKid({ verificationMethod: [vm('atproto')] }, '#other')).toBeNull();
    });

    it('tolerates a document with no verificationMethod at all', () => {
        expect(verificationMethodByKid({ service: [] }, '#atproto')).toBeNull();
        expect(verificationMethodByKid(null, '#atproto')).toBeNull();
    });
});

describe('requestOperation', () => {
    it('uses lxm for XRPC and op for REST', () => {
        expect(requestOperation('GET', '/xrpc/dev.antiphony.audio.getPost')).toEqual({
            kind: 'xrpc',
            lxm: 'dev.antiphony.audio.getPost',
        });
        expect(requestOperation('post', '/api/v1/posts')).toEqual({
            kind: 'rest',
            op: 'POST /api/v1/posts',
        });
    });
});

describe('verifySignedServiceAuth — accepts a well-formed token', () => {
    it('verifies a REST token and resolves the tenant from the pin registry', async () => {
        const r = await verify(await mint(keyPair.privateKey));
        expect(r).toMatchObject({ ok: true, originAppId: TENANT, kid: '#atproto' });
    });

    it('verifies an XRPC token bound with lxm', async () => {
        const token = await mint(keyPair.privateKey, {
            op: undefined,
            lxm: 'dev.antiphony.audio.getPost',
        });
        const r = await verify(token, {
            operation: requestOperation('GET', '/xrpc/dev.antiphony.audio.getPost'),
        });
        expect(r.ok).toBe(true);
    });

    it('selects the right key when a rotation window publishes two', async () => {
        const other = (await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
        )) as CryptoKeyPair;
        await seedPin([
            {
                id: `${ISSUER}#old`,
                type: 'Multikey',
                controller: ISSUER,
                publicKeyMultibase: await multibaseFor(other.publicKey),
            },
            {
                id: `${ISSUER}#atproto`,
                type: 'Multikey',
                controller: ISSUER,
                publicKeyMultibase: await multibaseFor(keyPair.publicKey),
            },
        ]);
        expect((await verify(await mint(keyPair.privateKey))).ok).toBe(true);
        // Signed with the old key but claiming the new kid — selection, not
        // trial-verification, is what makes this a failure.
        const forged = await mint(other.privateKey, {}, { kid: '#atproto' });
        expect(await verify(forged)).toMatchObject({ ok: false, reason: 'bad-signature' });
    });
});

describe('verifySignedServiceAuth — refuses', () => {
    it('a signature from a key the document does not list', async () => {
        const attacker = (await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
        )) as CryptoKeyPair;
        expect(await verify(await mint(attacker.privateKey))).toMatchObject({
            ok: false,
            reason: 'bad-signature',
        });
    });

    it('a tampered payload', async () => {
        const token = await mint(keyPair.privateKey);
        const [h, , s] = token.split('.');
        const swapped = encodeJson({
            iss: ISSUER,
            aud: AUDIENCE,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            op: 'DELETE /api/v1/posts/123',
        });
        expect(await verify(`${h}.${swapped}.${s}`)).toMatchObject({
            ok: false,
            reason: 'bad-signature',
        });
    });

    it('alg: none, and any alg that is not ES256', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const unsigned = `${encodeJson({ alg: 'none' })}.${encodeJson({
            iss: ISSUER,
            aud: AUDIENCE,
            iat: nowSec,
            exp: nowSec + 60,
            op: 'POST /api/v1/posts',
        })}.`;
        expect(await verify(unsigned)).toMatchObject({ ok: false, reason: 'unsupported-alg' });

        const hs = await mint(keyPair.privateKey, {}, { alg: 'HS256' });
        expect(await verify(hs)).toMatchObject({ ok: false, reason: 'unsupported-alg' });
    });

    it('a token carrying BOTH lxm and op', async () => {
        const token = await mint(keyPair.privateKey, {
            op: 'POST /api/v1/posts',
            lxm: 'dev.antiphony.audio.getPost',
        });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'both-operation-claims' });
    });

    it('a token carrying neither', async () => {
        const token = await mint(keyPair.privateKey, { op: undefined });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'no-operation-claim' });
    });

    it('a token bound to a different endpoint', async () => {
        const token = await mint(keyPair.privateKey, { op: 'GET /api/v1/posts' });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'operation-mismatch' });
    });

    it('a REST path smuggled through lxm', async () => {
        const token = await mint(keyPair.privateKey, { op: undefined, lxm: 'POST /api/v1/posts' });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'operation-mismatch' });
    });

    it('an audience naming the origin URL rather than the DID', async () => {
        const token = await mint(keyPair.privateKey, { aud: 'https://api.antiphony.dev' });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'audience-mismatch' });
    });

    it('an issuer not in the pin registry', async () => {
        const token = await mint(keyPair.privateKey, { iss: 'did:web:attacker.example' });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'unknown-issuer' });
    });

    it('an expired token, and one dated to the future', async () => {
        const token = await mint(keyPair.privateKey);
        const past = Date.now() + 10 * 60_000;
        expect(await verify(token, { now: () => past })).toMatchObject({
            ok: false,
            reason: 'expired',
        });
        const future = Date.now() - 10 * 60_000;
        expect(await verify(token, { now: () => future })).toMatchObject({
            ok: false,
            reason: 'not-yet-valid',
        });
    });

    it('tolerates modest clock skew in both directions', async () => {
        const token = await mint(keyPair.privateKey);
        expect((await verify(token, { now: () => Date.now() + 90_000 })).ok).toBe(true);
        expect((await verify(token, { now: () => Date.now() - 30_000 })).ok).toBe(true);
    });

    it('a lifetime long enough to make the no-replay-cache argument false', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const token = await mint(keyPair.privateKey, { iat: nowSec, exp: nowSec + 3600 });
        expect(await verify(token)).toMatchObject({ ok: false, reason: 'lifetime-too-long' });
    });

    it('a token whose tenant has no pin snapshot', async () => {
        resetValidatedPinsForTest();
        expect(await verify(await mint(keyPair.privateKey))).toMatchObject({
            ok: false,
            reason: 'no-pin-snapshot',
        });
    });

    it('structurally malformed input, without throwing', async () => {
        for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', '...', '@@@.@@@.@@@']) {
            const r = await verify(bad);
            expect(r.ok).toBe(false);
        }
    });

    it('a DER-encoded signature rather than raw r‖s', async () => {
        const token = await mint(keyPair.privateKey);
        const [h, p] = token.split('.');
        const der = b64url(new Uint8Array([0x30, 0x44, 0x02, 0x20]));
        expect(await verify(`${h}.${p}.${der}`)).toMatchObject({
            ok: false,
            reason: 'bad-signature',
        });
    });
});
