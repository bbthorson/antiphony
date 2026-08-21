import { base58btc } from 'multiformats/bases/base58';
import { parseAppDids, getValidatedPin } from './app-did.js';

/**
 * Verify the signed service-auth JWT Vox Pop sends in `X-Antiphony-Service-Auth`
 * — the contract in issue #116, and the eventual replacement for the shared
 * bearer token in `specs/service-auth.md`.
 *
 * ## This is NOT AT Protocol service auth
 *
 * It is atproto-*shaped* — `iss`/`aud` are DIDs, the key comes from a DID
 * document's `verificationMethod`, `lxm` is atproto's claim holding what
 * atproto says it holds — but it is an agreement between two services we
 * operate, not something a relay will ever consume. Do not "fix" this module by
 * reaching for `@atproto/xrpc-server`'s verifier: the `op` claim alone has no
 * meaning in that spec, and matching its behaviour would be a coincidence
 * rather than a contract.
 *
 * ## The keystore is the pin snapshot
 *
 * Verification does **no request-path network I/O**. `ensureTenantPin` has
 * already resolved and snapshotted the tenant's DID document by the time any
 * handler runs, so the key is a field read on something already in memory.
 *
 * Two consequences worth stating, because they are inherited rather than
 * chosen:
 *
 *   - The document is the one *last resolved*, on a one-hour freshness bound,
 *     with a 24h stale-serve window when the `did:web` host is unreachable. For
 *     a key lookup that is defensible today. If this ever becomes the ONLY
 *     credential, that window is the blast radius of Vox Pop's DID host going
 *     down, and it needs revisiting first (flagged on #116).
 *   - Nothing detects that the document CHANGED (#117). An attacker who
 *     controls the `did:web` host can add a `verificationMethod` and mint
 *     tokens we would accept. That is precisely why this ships log-only: the
 *     bearer token is still the credential, and this is an observation.
 *
 * ## Order of operations
 *
 * Structure → key → **signature** → claims. Claims are attacker-controlled
 * until the signature verifies, so nothing but `iss` and `kid` (which are
 * lookup hints, and wrong ones simply select a key that fails) is trusted
 * before that point. Checking `exp` first would be free of consequence today
 * and exactly the kind of ordering that rots into a vulnerability.
 */

/** The header the signed token arrives in. */
export const SERVICE_AUTH_HEADER = 'x-antiphony-service-auth';

/**
 * Why a verification failed — a closed set, because these end up in log lines
 * that get counted. A free-text reason makes "how often does the `kid` miss"
 * unanswerable without a regex over logs.
 */
export type SignedServiceAuthFailure =
    | 'malformed-token'
    | 'unsupported-alg'
    | 'missing-kid'
    | 'malformed-claims'
    | 'both-operation-claims'
    | 'no-operation-claim'
    | 'unknown-issuer'
    | 'ambiguous-issuer'
    | 'no-pin-snapshot'
    | 'no-verification-method'
    | 'unsupported-key-type'
    | 'malformed-key'
    | 'bad-signature'
    | 'audience-mismatch'
    | 'expired'
    | 'not-yet-valid'
    | 'lifetime-too-long'
    | 'operation-mismatch';

export interface SignedServiceAuthClaims {
    iss: string;
    aud: string;
    iat: number;
    exp: number;
    /** NSID, on XRPC calls only. Mutually exclusive with `op`. */
    lxm?: string;
    /** `"<METHOD> <path>"`, on REST calls only. Mutually exclusive with `lxm`. */
    op?: string;
}

export type SignedServiceAuthResult =
    | { ok: true; originAppId: string; claims: SignedServiceAuthClaims; kid: string }
    | { ok: false; reason: SignedServiceAuthFailure; detail?: string };

/**
 * The operation the token must be bound to, derived from the request being
 * served — never from the token.
 *
 * XRPC calls carry an NSID and use `lxm`; REST calls have no NSID and use `op`.
 * The split is deliberate on the signer's side: `"POST /api/v1/posts"` in `lxm`
 * would be read as a lexicon method by anything spec-aware, and be wrong.
 */
export type RequestOperation =
    | { kind: 'xrpc'; lxm: string }
    | { kind: 'rest'; op: string };

/**
 * Derive the expected operation from a method and path.
 *
 * `/xrpc/<nsid>` is the XRPC surface; everything else is REST. The path must
 * arrive WITHOUT a query string — `op` binds the endpoint, not the arguments,
 * and including them would make every distinct query a distinct operation.
 */
export function requestOperation(method: string, path: string): RequestOperation {
    const XRPC_PREFIX = '/xrpc/';
    if (path.startsWith(XRPC_PREFIX)) {
        return { kind: 'xrpc', lxm: path.slice(XRPC_PREFIX.length) };
    }
    return { kind: 'rest', op: `${method.toUpperCase()} ${path}` };
}

/**
 * Clock skew tolerated on `iat` / `exp`, in ms.
 *
 * Both sides run on Cloudflare edges, which are NTP-disciplined, so this is
 * generous. It is not free — it extends the window in which a captured token
 * replays — but 60s against a 60s lifetime is the same order as the lifetime
 * itself, and refusing a token because two datacentres disagree by a second is
 * a worse failure than the one being prevented.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * Longest `exp - iat` accepted.
 *
 * The reason there is no `jti` replay cache is that the lifetime is short
 * enough not to need one. That argument is load-bearing, and it silently stops
 * holding if the signer ever widens the window — so the assumption is enforced
 * here rather than trusted. Set well above the 60s the signer uses, because
 * this is a backstop against a category of change, not a check on the current
 * value.
 */
const MAX_LIFETIME_MS = 300_000;

/** p256-pub, the multicodec prefix on a P-256 public key. */
const P256_PUB_MULTICODEC = [0x80, 0x24] as const;

/**
 * DER prefix that turns a 33-byte COMPRESSED SEC1 point into a P-256 SPKI.
 *
 * WebCrypto's `importKey('raw', …)` wants the uncompressed 65-byte form, and
 * whether it accepts a compressed one is implementation-defined: OpenSSL (Node)
 * uncompresses happily, BoringSSL (workerd — the runtime that matters here)
 * does not. Wrapping in SPKI works on both, so it is the only path taken.
 *
 * The outer length is `0x39` (57), NOT the `0x59` of the far more commonly
 * pasted uncompressed-point prefix. Getting that byte wrong yields an opaque
 * ASN.1 error that says nothing about which byte was wrong.
 */
const SPKI_P256_COMPRESSED_PREFIX = new Uint8Array([
    0x30, 0x39, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x22, 0x00,
]);

// `Uint8Array<ArrayBuffer>`, not the bare alias: TS 5.7 widens the default to
// `ArrayBufferLike`, which includes `SharedArrayBuffer` and so is not a
// `BufferSource` WebCrypto will accept.
function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> | null {
    // Reject anything outside the base64url alphabet up front. `atob` is
    // lenient about some of it, and a token that decodes differently here than
    // it did at the signer is the seed of a signature-confusion bug.
    if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    try {
        const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

function decodeJson(segment: string): unknown | null {
    const bytes = base64UrlToBytes(segment);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

interface DidVerificationMethod {
    id?: string;
    type?: string;
    controller?: string;
    publicKeyMultibase?: string;
}

/**
 * Select the verification method a `kid` names — by fragment, from an array
 * that may hold more than one.
 *
 * **Select, don't trial-verify.** Trying every key until one works would make a
 * rotation window succeed by accident and would erase the distinction between
 * "signed with the key it claimed" and "signed with some key this DID happens
 * to list". `kid` exists precisely so the choice is explicit.
 *
 * Never assume a single entry: additive rotation — publish the new key
 * alongside the old, flip the signer, retire the old — is the documented
 * procedure on both sides (#116 §4).
 */
export function verificationMethodByKid(
    doc: unknown,
    kid: string,
): DidVerificationMethod | null {
    const methods = (doc as { verificationMethod?: DidVerificationMethod[] })
        ?.verificationMethod;
    if (!Array.isArray(methods)) return null;
    const fragment = kid.startsWith('#') ? kid : `#${kid}`;
    for (const vm of methods) {
        if (!vm || typeof vm !== 'object' || typeof vm.id !== 'string') continue;
        // The document's id is fully qualified (`did:web:…#atproto`); the token's
        // `kid` is the bare fragment. Compare on the fragment so both forms work.
        const vmFragment = vm.id.slice(vm.id.indexOf('#'));
        if (vmFragment === fragment) return vm;
    }
    return null;
}

/**
 * Decode a `publicKeyMultibase` into a WebCrypto P-256 verification key.
 *
 * multibase(`z`, base58btc) → strip the 2-byte `p256-pub` multicodec → 33-byte
 * compressed SEC1 point → SPKI → import.
 */
export async function importMultikeyP256(
    publicKeyMultibase: string,
): Promise<CryptoKey | null> {
    let decoded: Uint8Array;
    try {
        // `base58btc.decode` expects the multibase prefix, so pass it intact —
        // it validates the `z` rather than us assuming it.
        decoded = base58btc.decode(publicKeyMultibase);
    } catch {
        return null;
    }
    if (
        decoded.length !== 35 ||
        decoded[0] !== P256_PUB_MULTICODEC[0] ||
        decoded[1] !== P256_PUB_MULTICODEC[1]
    ) {
        return null;
    }
    const point = decoded.subarray(2);
    // Compressed points start 0x02 (even y) or 0x03 (odd y). An uncompressed
    // 0x04 point would be the wrong length and already rejected above.
    if (point[0] !== 0x02 && point[0] !== 0x03) return null;

    const spki = new Uint8Array(SPKI_P256_COMPRESSED_PREFIX.length + point.length);
    spki.set(SPKI_P256_COMPRESSED_PREFIX, 0);
    spki.set(point, SPKI_P256_COMPRESSED_PREFIX.length);

    try {
        return await crypto.subtle.importKey(
            'spki',
            spki,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
        );
    } catch {
        // A well-formed prefix over a point that is not on the curve lands
        // here. That is a malformed key, not a malformed token.
        return null;
    }
}

/**
 * Resolve an issuer DID to the tenant it is pinned for.
 *
 * **The pin registry IS the issuer registry** — deliberately not a second one.
 * `ANTIPHONY_APP_DIDS` already states which DID belongs to which tenant, and a
 * parallel list is a thing that can disagree with it. This also preserves the
 * `service-auth.md` invariant that `originAppId` comes from the credential and
 * never from the request, and arguably tightens it: today the credential is a
 * shared secret, and under this scheme it is a signature attributable to a key
 * only the tenant holds.
 *
 * Ambiguity is refused rather than resolved. Two tenants pinned to one DID is a
 * misconfiguration, and picking either one silently would assign a request to a
 * tenancy by iteration order.
 */
function tenantForIssuer(iss: string): { ok: true; originAppId: string } | { ok: false; reason: 'unknown-issuer' | 'ambiguous-issuer' } {
    let found: string | null = null;
    for (const [originAppId, did] of parseAppDids()) {
        if (did !== iss) continue;
        if (found !== null) return { ok: false, reason: 'ambiguous-issuer' };
        found = originAppId;
    }
    return found === null ? { ok: false, reason: 'unknown-issuer' } : { ok: true, originAppId: found };
}

function parseClaims(raw: unknown): SignedServiceAuthClaims | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.iss !== 'string' || !c.iss) return null;
    if (typeof c.aud !== 'string' || !c.aud) return null;
    if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) return null;
    if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return null;
    if (c.lxm !== undefined && typeof c.lxm !== 'string') return null;
    if (c.op !== undefined && typeof c.op !== 'string') return null;
    return {
        iss: c.iss,
        aud: c.aud,
        iat: c.iat,
        exp: c.exp,
        ...(typeof c.lxm === 'string' ? { lxm: c.lxm } : {}),
        ...(typeof c.op === 'string' ? { op: c.op } : {}),
    };
}

export interface VerifySignedServiceAuthOptions {
    /** Antiphony's own DID — the only accepted `aud`. */
    expectedAudience: string;
    /** The operation being served, derived from the request. */
    operation: RequestOperation;
    /** Injectable clock, for tests. */
    now?: () => number;
}

/**
 * Verify a compact JWS from `X-Antiphony-Service-Auth`.
 *
 * Returns a result rather than throwing: every caller today is an observer, and
 * a failure is a thing to count, not an exception to propagate.
 */
export async function verifySignedServiceAuth(
    token: string,
    opts: VerifySignedServiceAuthOptions,
): Promise<SignedServiceAuthResult> {
    const now = opts.now?.() ?? Date.now();

    const segments = token.split('.');
    if (segments.length !== 3) return { ok: false, reason: 'malformed-token' };
    const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];

    const header = decodeJson(headerSeg) as { alg?: unknown; kid?: unknown } | null;
    if (!header || typeof header !== 'object') return { ok: false, reason: 'malformed-token' };

    // ES256 only. No algorithm agility: the signer emits one algorithm, so
    // accepting a set buys nothing and opens the door `alg: "none"` walks
    // through. A future second algorithm is a deliberate change here.
    if (header.alg !== 'ES256') {
        return { ok: false, reason: 'unsupported-alg', detail: String(header.alg) };
    }
    if (typeof header.kid !== 'string' || !header.kid) {
        return { ok: false, reason: 'missing-kid' };
    }
    const kid = header.kid;

    const claims = parseClaims(decodeJson(payloadSeg));
    if (!claims) return { ok: false, reason: 'malformed-claims' };

    // Exactly one operation claim. Both present is malformed by contract, not
    // merely redundant — it lets a verifier that checks only one accept a token
    // bound to a different endpoint by the other.
    if (claims.lxm !== undefined && claims.op !== undefined) {
        return { ok: false, reason: 'both-operation-claims' };
    }
    if (claims.lxm === undefined && claims.op === undefined) {
        return { ok: false, reason: 'no-operation-claim' };
    }

    const tenant = tenantForIssuer(claims.iss);
    if (!tenant.ok) return { ok: false, reason: tenant.reason, detail: claims.iss };

    const pin = getValidatedPin(tenant.originAppId);
    if (!pin) return { ok: false, reason: 'no-pin-snapshot', detail: tenant.originAppId };

    const vm = verificationMethodByKid(pin.document, kid);
    if (!vm) return { ok: false, reason: 'no-verification-method', detail: kid };
    if (vm.type !== 'Multikey') {
        return { ok: false, reason: 'unsupported-key-type', detail: String(vm.type) };
    }
    if (typeof vm.publicKeyMultibase !== 'string') {
        return { ok: false, reason: 'malformed-key' };
    }

    const key = await importMultikeyP256(vm.publicKeyMultibase);
    if (!key) return { ok: false, reason: 'malformed-key' };

    const signature = base64UrlToBytes(signatureSeg);
    // JWS ES256 signatures are raw r‖s, 64 bytes — which is also what WebCrypto
    // expects. A DER-wrapped signature would land here and be refused, which is
    // correct: it is not the encoding this contract specifies.
    if (!signature || signature.length !== 64) {
        return { ok: false, reason: 'bad-signature', detail: 'signature-encoding' };
    }

    const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    let verified = false;
    try {
        verified = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            signature,
            signingInput,
        );
    } catch {
        verified = false;
    }
    if (!verified) return { ok: false, reason: 'bad-signature' };

    // --- Everything below here is a claim we now know the tenant asserted. ---

    // `aud` names an identity, not an address. An audience bound to an origin
    // URL is bound to wherever traffic happens to point, which is the exact
    // substitution the claim exists to prevent.
    if (claims.aud !== opts.expectedAudience) {
        return { ok: false, reason: 'audience-mismatch', detail: claims.aud };
    }

    const expMs = claims.exp * 1000;
    const iatMs = claims.iat * 1000;
    if (now > expMs + CLOCK_SKEW_MS) return { ok: false, reason: 'expired' };
    if (iatMs > now + CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
    if (expMs - iatMs > MAX_LIFETIME_MS) return { ok: false, reason: 'lifetime-too-long' };

    // Bind to the operation actually being served. This is what makes a
    // captured token useless against a different endpoint, and it is the reason
    // a 60s lifetime is sufficient without a replay cache.
    const expected = opts.operation;
    const matches =
        expected.kind === 'xrpc' ? claims.lxm === expected.lxm : claims.op === expected.op;
    if (!matches) {
        return {
            ok: false,
            reason: 'operation-mismatch',
            detail: `token=${claims.lxm ?? claims.op} request=${expected.kind === 'xrpc' ? expected.lxm : expected.op}`,
        };
    }

    return { ok: true, originAppId: tenant.originAppId, claims, kid };
}
