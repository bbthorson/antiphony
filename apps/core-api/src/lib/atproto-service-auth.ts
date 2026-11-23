import { createDidResolver } from '@atproto-labs/did-resolver';
import { verifySignature } from '@atproto/crypto';
import { isValidDid, type DidString } from '@atproto/syntax';

/**
 * Verify AT Protocol inter-service authentication JWTs
 * (https://atproto.com/specs/xrpc#inter-service-authentication-temporary-specification;
 * specs/xrpc-surface.md D-2).
 *
 * Distinct from `signed-service-auth.ts`, which verifies Antiphony's own
 * tenant-to-Antiphony `X-Antiphony-Service-Auth` header against pinned tenant
 * DID documents. This module verifies standard ATProto service-auth JWTs sent
 * in `Authorization: Bearer <jwt>` by external ATProto services (AppViews,
 * PDSes proxying on behalf of a user).
 *
 * ## Order of operations
 *
 * Structure → claims shape (`iss` DID) → key resolution → **signature** →
 * temporal & scope claims (`aud`, `lxm`, `exp`, `iat`). Nothing is trusted
 * before the signature verifies against the issuer's `#atproto` key.
 */

const DOC_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SEC = 30;
const MAX_LIFETIME_SEC = 600; // 10 minutes
const ALLOWED_ALGS = new Set(['ES256', 'ES256K']);

export type AtprotoServiceAuthFailure =
    | 'malformed-token'
    | 'unsupported-alg'
    | 'malformed-claims'
    | 'audience-unconfigured'
    | 'did-resolution-failed'
    | 'no-atproto-key'
    | 'bad-signature'
    | 'audience-mismatch'
    | 'lxm-mismatch'
    | 'expired'
    | 'not-yet-valid'
    | 'lifetime-too-long';

export interface AtprotoServiceAuthClaims {
    iss: string;
    aud: string;
    exp: number;
    iat?: number;
    lxm?: string;
    jti?: string;
}

export type AtprotoServiceAuthResult =
    | { ok: true; iss: string; claims: AtprotoServiceAuthClaims }
    | { ok: false; reason: AtprotoServiceAuthFailure };

export interface VerifyAtprotoServiceAuthOptions {
    /** This deployment's own service DID (`did:web:api.antiphony.dev`). */
    expectedAudience: string | undefined;
    /** The XRPC NSID being called (`dev.antiphony.audio.getPost`, etc.). */
    expectedLxm: string;
    /** Override current epoch seconds (tests). */
    nowSec?: number;
    /** Override DID → `#atproto` `did:key:...` resolution (tests). */
    resolveDidKey?: (iss: string) => Promise<string | null>;
    /** Override `fetch` used by the default DID resolver (tests). */
    fetchImpl?: typeof fetch;
}

function decodeBase64Url(segment: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
    try {
        const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
        const std = padded.replace(/-/g, '+').replace(/_/g, '/');
        return new Uint8Array(Buffer.from(std, 'base64'));
    } catch {
        return null;
    }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** HTTPS-only, no-redirect, timeout-bounded fetch for DID document lookups. */
function guardedDidFetch(fetchImpl: typeof fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.protocol !== 'https:') {
            throw new Error(`refused non-HTTPS DID document fetch: ${url.protocol}`);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOC_TIMEOUT_MS);
        try {
            return await fetchImpl(input, {
                ...init,
                redirect: 'error',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }) as typeof fetch;
}

/** Resolve an issuer's `#atproto` verification method to a `did:key:...` string. */
async function defaultResolveDidKey(iss: string, fetchImpl: typeof fetch): Promise<string | null> {
    const resolver = createDidResolver({ allowHttp: false, fetch: guardedDidFetch(fetchImpl) });
    const doc = await resolver.resolve(iss as DidString);
    const methods = doc.verificationMethod ?? [];
    for (const vm of methods) {
        const id = vm.id;
        const isAtprotoKey = id === '#atproto' || id === `${iss}#atproto` || id.endsWith('#atproto');
        if (!isAtprotoKey) continue;
        if (typeof vm.publicKeyMultibase === 'string' && vm.publicKeyMultibase.startsWith('z')) {
            return `did:key:${vm.publicKeyMultibase}`;
        }
    }
    return null;
}

export async function verifyAtprotoServiceAuth(
    token: string,
    opts: VerifyAtprotoServiceAuthOptions,
): Promise<AtprotoServiceAuthResult> {
    if (!opts.expectedAudience) {
        return { ok: false, reason: 'audience-unconfigured' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed-token' };
    const [headerB64, payloadB64, sigB64] = parts;

    const headerBytes = decodeBase64Url(headerB64);
    const payloadBytes = decodeBase64Url(payloadB64);
    const sigBytes = decodeBase64Url(sigB64);
    if (!headerBytes || !payloadBytes || !sigBytes || sigBytes.byteLength === 0) {
        return { ok: false, reason: 'malformed-token' };
    }

    const header = parseJsonObject(headerBytes);
    if (!header || typeof header.alg !== 'string') {
        return { ok: false, reason: 'malformed-token' };
    }
    if (!ALLOWED_ALGS.has(header.alg)) {
        return { ok: false, reason: 'unsupported-alg' };
    }

    const payload = parseJsonObject(payloadBytes);
    if (
        !payload ||
        typeof payload.iss !== 'string' ||
        !isValidDid(payload.iss) ||
        typeof payload.aud !== 'string' ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp)
    ) {
        return { ok: false, reason: 'malformed-claims' };
    }
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat))) {
        return { ok: false, reason: 'malformed-claims' };
    }
    if (payload.lxm !== undefined && typeof payload.lxm !== 'string') {
        return { ok: false, reason: 'malformed-claims' };
    }

    const claims: AtprotoServiceAuthClaims = {
        iss: payload.iss,
        aud: payload.aud,
        exp: payload.exp,
        ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
        ...(typeof payload.lxm === 'string' ? { lxm: payload.lxm } : {}),
        ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
    };

    // Resolve key and verify cryptographic signature BEFORE checking claims.
    let didKey: string | null;
    try {
        didKey = opts.resolveDidKey
            ? await opts.resolveDidKey(claims.iss)
            : await defaultResolveDidKey(claims.iss, opts.fetchImpl ?? fetch);
    } catch {
        return { ok: false, reason: 'did-resolution-failed' };
    }
    if (!didKey) {
        return { ok: false, reason: 'no-atproto-key' };
    }

    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    let validSig: boolean;
    try {
        validSig = await verifySignature(didKey, signingInput, sigBytes);
    } catch {
        validSig = false;
    }
    if (!validSig) {
        return { ok: false, reason: 'bad-signature' };
    }

    // Claims checks (post-signature).
    if (claims.aud !== opts.expectedAudience) {
        return { ok: false, reason: 'audience-mismatch' };
    }
    if (claims.lxm !== opts.expectedLxm) {
        return { ok: false, reason: 'lxm-mismatch' };
    }

    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (claims.exp + CLOCK_SKEW_SEC < nowSec) {
        return { ok: false, reason: 'expired' };
    }
    if (claims.iat !== undefined) {
        if (claims.iat - CLOCK_SKEW_SEC > nowSec) {
            return { ok: false, reason: 'not-yet-valid' };
        }
        if (claims.exp - claims.iat > MAX_LIFETIME_SEC) {
            return { ok: false, reason: 'lifetime-too-long' };
        }
    }

    return { ok: true, iss: claims.iss, claims };
}
