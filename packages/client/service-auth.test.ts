import { describe, it, expect } from 'vitest';
import {
    signServiceAuth,
    createServiceAuthSigner,
    importPrivateKeyJwk,
    importPrivateKeyPkcs8,
} from './service-auth';

function decodeSegment(seg: string): unknown {
    const padded = seg.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (seg.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function base64UrlToBytes(seg: string): Uint8Array<ArrayBuffer> {
    const padded = seg.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (seg.length % 4)) % 4);
    const buf = Buffer.from(padded, 'base64');
    const out = new Uint8Array(buf.length);
    out.set(buf);
    return out;
}

describe('signServiceAuth & createServiceAuthSigner', () => {
    it('signs a valid ES256 XRPC JWT verifiable with the matching P-256 public key', async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify',
        ]);

        const token = await signServiceAuth({
            iss: 'did:web:did.voxpop.audio',
            aud: 'did:web:api.antiphony.dev',
            kid: '#atproto',
            privateKey: pair.privateKey,
            operation: { kind: 'xrpc', lxm: 'dev.antiphony.audio.createPost' },
            lifetimeSec: 60,
            nowSec: 1_760_000_000,
        });

        const [headerB64, payloadB64, sigB64] = token.split('.');
        expect(decodeSegment(headerB64)).toEqual({ typ: 'JWT', alg: 'ES256', kid: 'atproto' });
        expect(decodeSegment(payloadB64)).toEqual({
            iss: 'did:web:did.voxpop.audio',
            aud: 'did:web:api.antiphony.dev',
            iat: 1_760_000_000,
            exp: 1_760_000_060,
            lxm: 'dev.antiphony.audio.createPost',
        });

        const verified = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.publicKey,
            base64UrlToBytes(sigB64),
            new TextEncoder().encode(`${headerB64}.${payloadB64}`),
        );
        expect(verified).toBe(true);
    });

    it('emits op for REST operations and supports PKCS#8 and JWK key imports', async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify',
        ]);
        const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
        const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

        const keyFromPem = await importPrivateKeyPkcs8(
            `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
        );
        const keyFromJwk = await importPrivateKeyJwk(jwk);

        const signerA = createServiceAuthSigner({
            iss: 'did:web:did.voxpop.audio',
            aud: 'did:web:api.antiphony.dev',
            kid: 'atproto',
            privateKey: keyFromPem,
        });
        const signerB = createServiceAuthSigner({
            iss: 'did:web:did.voxpop.audio',
            aud: 'did:web:api.antiphony.dev',
            kid: 'atproto',
            privateKey: keyFromJwk,
        });

        const tokA = await signerA({ kind: 'rest', op: 'POST /api/v1/posts' });
        const tokB = await signerB({ kind: 'xrpc', lxm: 'dev.antiphony.audio.getPost' });

        expect((decodeSegment(tokA.split('.')[1]) as { op: string }).op).toBe('POST /api/v1/posts');
        expect((decodeSegment(tokB.split('.')[1]) as { lxm: string }).lxm).toBe('dev.antiphony.audio.getPost');
    });
});
