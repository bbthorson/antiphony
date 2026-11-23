/**
 * WebCrypto ES256 (P-256) signer for Antiphony's `X-Antiphony-Service-Auth`
 * header (`apps/core-api/src/lib/signed-service-auth.ts`).
 *
 * Pure WebCrypto (`crypto.subtle`) with zero external dependencies, so it runs
 * identically on Cloudflare Workers, Node 26+, Deno, and Bun.
 */

export const SERVICE_AUTH_HEADER = 'x-antiphony-service-auth';

export type ServiceAuthOperation =
    | { kind: 'xrpc'; lxm: string }
    | { kind: 'rest'; op: string };

export interface SignServiceAuthOptions {
    /** Tenant app DID (`did:web:...` or `did:plc:...`). */
    iss: string;
    /** Target Antiphony service DID (e.g. `did:web:api.antiphony.dev`). */
    aud: string;
    /** Key fragment matching the DID document's `verificationMethod` (e.g. `atproto` or `#atproto`). */
    kid: string;
    /** WebCrypto ECDSA P-256 private key (`sign` usage). */
    privateKey: CryptoKey;
    /** The operation this token is bound to (`lxm` for XRPC, `op` for REST). */
    operation: ServiceAuthOperation;
    /** Lifetime in seconds (default 60; core-api refuses > 300). */
    lifetimeSec?: number;
    /** Override current epoch seconds (tests). */
    nowSec?: number;
}

export type ServiceAuthSigner = (operation: ServiceAuthOperation) => Promise<string>;

export interface ServiceAuthSignerConfig {
    iss: string;
    aud: string;
    kid: string;
    privateKey: CryptoKey;
    lifetimeSec?: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonToBase64Url(value: unknown): string {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Import a PKCS#8 PEM or base64-encoded P-256 private key for ES256 signing. */
export async function importPrivateKeyPkcs8(pemOrBase64: string): Promise<CryptoKey> {
    const cleaned = pemOrBase64
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s+/g, '');
    const binary = atob(cleaned);
    const der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
    return crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    );
}

/** Import a P-256 JWK private key for ES256 signing. */
export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    );
}

/** Mint a single short-lived ES256 `X-Antiphony-Service-Auth` JWT. */
export async function signServiceAuth(opts: SignServiceAuthOptions): Promise<string> {
    const iat = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const exp = iat + (opts.lifetimeSec ?? 60);
    const kid = opts.kid.startsWith('#') ? opts.kid.slice(1) : opts.kid;

    const header = { typ: 'JWT', alg: 'ES256', kid };
    const payload =
        opts.operation.kind === 'xrpc'
            ? { iss: opts.iss, aud: opts.aud, iat, exp, lxm: opts.operation.lxm }
            : { iss: opts.iss, aud: opts.aud, iat, exp, op: opts.operation.op };

    const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
    const sigBuffer = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        opts.privateKey,
        new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuffer))}`;
}

/** Create a reusable signer bound to one tenant DID and private key. */
export function createServiceAuthSigner(config: ServiceAuthSignerConfig): ServiceAuthSigner {
    return (operation) =>
        signServiceAuth({
            iss: config.iss,
            aud: config.aud,
            kid: config.kid,
            privateKey: config.privateKey,
            lifetimeSec: config.lifetimeSec,
            operation,
        });
}
