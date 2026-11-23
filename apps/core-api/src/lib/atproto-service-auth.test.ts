import { describe, it, expect } from 'vitest';
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto';
import { verifyAtprotoServiceAuth } from './atproto-service-auth.js';

function b64url(input: Uint8Array | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(
    keypair: P256Keypair | Secp256k1Keypair,
    alg: 'ES256' | 'ES256K',
    claims: Record<string, unknown>,
): Promise<string> {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg }));
    const payload = b64url(JSON.stringify(claims));
    const sig = await keypair.sign(new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(sig)}`;
}

const AUD = 'did:web:api.antiphony.dev';
const LXM = 'dev.antiphony.audio.getPost';
const ISS = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const NOW = 1_760_000_000;

describe('verifyAtprotoServiceAuth', () => {
    it('accepts a valid ES256 (P-256) and ES256K (secp256k1) service-auth JWT', async () => {
        const p256 = await P256Keypair.create();
        const jwtP256 = await signJwt(p256, 'ES256', { iss: ISS, aud: AUD, lxm: LXM, iat: NOW, exp: NOW + 60 });
        const res1 = await verifyAtprotoServiceAuth(jwtP256, {
            expectedAudience: AUD,
            expectedLxm: LXM,
            nowSec: NOW,
            resolveDidKey: async () => p256.did(),
        });
        expect(res1).toEqual({
            ok: true,
            iss: ISS,
            claims: { iss: ISS, aud: AUD, lxm: LXM, iat: NOW, exp: NOW + 60 },
        });

        const k256 = await Secp256k1Keypair.create();
        const jwtK256 = await signJwt(k256, 'ES256K', { iss: ISS, aud: AUD, lxm: LXM, exp: NOW + 60 });
        const res2 = await verifyAtprotoServiceAuth(jwtK256, {
            expectedAudience: AUD,
            expectedLxm: LXM,
            nowSec: NOW,
            resolveDidKey: async () => k256.did(),
        });
        expect(res2.ok).toBe(true);
    });

    it('rejects when expectedAudience is unconfigured', async () => {
        const res = await verifyAtprotoServiceAuth('a.b.c', {
            expectedAudience: undefined,
            expectedLxm: LXM,
        });
        expect(res).toEqual({ ok: false, reason: 'audience-unconfigured' });
    });

    it('rejects malformed tokens, unsupported alg, and bad claims', async () => {
        expect(
            await verifyAtprotoServiceAuth('not-a-jwt', { expectedAudience: AUD, expectedLxm: LXM }),
        ).toEqual({ ok: false, reason: 'malformed-token' });

        const hs256 = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url('{}')}.${b64url('sig')}`;
        expect(
            await verifyAtprotoServiceAuth(hs256, { expectedAudience: AUD, expectedLxm: LXM }),
        ).toEqual({ ok: false, reason: 'unsupported-alg' });

        const badIss = `${b64url(JSON.stringify({ alg: 'ES256' }))}.${b64url(JSON.stringify({ iss: 'not-a-did', aud: AUD, exp: NOW + 60 }))}.${b64url('sig')}`;
        expect(
            await verifyAtprotoServiceAuth(badIss, { expectedAudience: AUD, expectedLxm: LXM }),
        ).toEqual({ ok: false, reason: 'malformed-claims' });
    });

    it('rejects bad signature, wrong audience, wrong lxm, expired, and excessive lifetime', async () => {
        const signer = await P256Keypair.create();
        const other = await P256Keypair.create();

        const validToken = await signJwt(signer, 'ES256', { iss: ISS, aud: AUD, lxm: LXM, iat: NOW, exp: NOW + 60 });
        expect(
            await verifyAtprotoServiceAuth(validToken, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => other.did(),
            }),
        ).toEqual({ ok: false, reason: 'bad-signature' });

        const wrongAud = await signJwt(signer, 'ES256', {
            iss: ISS,
            aud: 'did:web:other.example',
            lxm: LXM,
            exp: NOW + 60,
        });
        expect(
            await verifyAtprotoServiceAuth(wrongAud, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => signer.did(),
            }),
        ).toEqual({ ok: false, reason: 'audience-mismatch' });

        const wrongLxm = await signJwt(signer, 'ES256', {
            iss: ISS,
            aud: AUD,
            lxm: 'dev.antiphony.audio.getThread',
            exp: NOW + 60,
        });
        expect(
            await verifyAtprotoServiceAuth(wrongLxm, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => signer.did(),
            }),
        ).toEqual({ ok: false, reason: 'lxm-mismatch' });

        const expired = await signJwt(signer, 'ES256', { iss: ISS, aud: AUD, lxm: LXM, exp: NOW - 60 });
        expect(
            await verifyAtprotoServiceAuth(expired, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => signer.did(),
            }),
        ).toEqual({ ok: false, reason: 'expired' });

        const tooLong = await signJwt(signer, 'ES256', { iss: ISS, aud: AUD, lxm: LXM, iat: NOW, exp: NOW + 3600 });
        expect(
            await verifyAtprotoServiceAuth(tooLong, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => signer.did(),
            }),
        ).toEqual({ ok: false, reason: 'lifetime-too-long' });
    });

    it('fails closed when DID resolution throws or returns no #atproto key', async () => {
        const signer = await P256Keypair.create();
        const token = await signJwt(signer, 'ES256', { iss: ISS, aud: AUD, lxm: LXM, exp: NOW + 60 });

        expect(
            await verifyAtprotoServiceAuth(token, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => {
                    throw new Error('network error');
                },
            }),
        ).toEqual({ ok: false, reason: 'did-resolution-failed' });

        expect(
            await verifyAtprotoServiceAuth(token, {
                expectedAudience: AUD,
                expectedLxm: LXM,
                nowSec: NOW,
                resolveDidKey: async () => null,
            }),
        ).toEqual({ ok: false, reason: 'no-atproto-key' });
    });
});
