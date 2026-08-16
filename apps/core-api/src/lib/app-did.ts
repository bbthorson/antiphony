import { isValidDid } from '@atproto/syntax';
import { logger } from './logger.js';

/**
 * Per-tenant app-DID registry — the "pinning layer" from
 * `specs/atproto-authority-model.md`. Each tenant (`originAppId`) is pinned to
 * an **app DID** that is the `at://` authority for every record it writes
 * (`at://{appDid}/{collection}/{rkey}`).
 *
 * Two deliberately separate halves, joined by a boot-time snapshot:
 *  - **The pin (sync):** parse `ANTIPHONY_APP_DIDS` (`appId:did,appId2:did2`)
 *    into an opaque `originAppId → did` map. The DID is stored and returned
 *    verbatim — nothing downstream re-derives it from a domain.
 *  - **Validation (async, off the hot path):** resolve a `did:web` document,
 *    require an `#atproto_pds` service endpoint (pointing at Antiphony), and
 *    snapshot it. Run at boot / onboarding, never per request.
 *
 * The connective tissue is `validateAllPins()`: at boot it validates every
 * configured pin, **fails the process closed** on any failure, and caches the
 * validated snapshot in memory. `getAppDid()` — the sync hot-path accessor —
 * serves *only* from that snapshot, so a DID whose custody claim we never
 * proved can never reach an `at://` uri. Parsing without validating is
 * deliberately not exposed: the raw pin is an input to validation, not a value
 * callers can serve.
 *
 * Mirrors `service-auth.ts`: lazy parse, cached on the raw env value,
 * fail-closed per entry. A tenant-registry collection is the eventual upgrade
 * path; this module is the swap point.
 */

let cachedPins: Map<string, string> | null = null;
let cachedRaw: string | undefined;

/**
 * Parse `ANTIPHONY_APP_DIDS` into an `originAppId → did` map. Split on the
 * FIRST colon only — the DID itself contains colons (`did:web:example.com:path`),
 * so the app id is the head and the DID is the remainder. Malformed or
 * non-DID entries are dropped with an error log (fail-closed for that tenant).
 * Cached on the raw string so the hot path pays no re-parse.
 */
export function parseAppDids(raw: string | undefined = process.env.ANTIPHONY_APP_DIDS): Map<string, string> {
    if (raw === cachedRaw && cachedPins !== null) return cachedPins;
    cachedRaw = raw;
    cachedPins = parseAppDidsUncached(raw);
    return cachedPins;
}

function parseAppDidsUncached(raw: string | undefined): Map<string, string> {
    const pins = new Map<string, string>();
    if (!raw || !raw.trim()) return pins;
    for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const appId = sep > 0 ? trimmed.slice(0, sep).trim() : '';
        const did = sep > 0 ? trimmed.slice(sep + 1).trim() : '';
        if (!appId || !did) {
            logger.error({ entry: trimmed.slice(0, 24) }, '[app-did] malformed ANTIPHONY_APP_DIDS entry; ignoring');
            continue;
        }
        // Gate the pinned authority with the reference DID syntax validator, not
        // just a `did:` prefix — a syntactically bad DID fails closed here with a
        // clear reason, before it ever reaches did:web resolution.
        if (!isValidDid(did)) {
            logger.error({ appId }, '[app-did] app authority is not a valid DID; ignoring entry');
            continue;
        }
        pins.set(appId, did);
    }
    return pins;
}

// --- Validation (async, off the hot path) ----------------------------------

/** Time-box each did:web resolve so a hanging endpoint can't block the boot gate. */
const DID_FETCH_TIMEOUT_MS = 5000;

/** True if a decoded DID segment smuggles a char that would escape the host/path. */
function escapesHostOrPath(s: string): boolean {
    return s.includes('/') || s.includes('\\') || s.includes('?') || s.includes('#') || s.includes('@');
}

/**
 * Derive the `did:web` document URL:
 *   `did:web:host`        → `https://host/.well-known/did.json`
 *   `did:web:host:a:b`    → `https://host/a/b/did.json`
 * Percent-encoded colons in the host (`did:web:localhost%3A8080`) are decoded.
 * Returns `null` for a non-`did:web` DID, malformed percent-encoding, or a
 * decoded segment that would escape the host/path (`/`, `\`, `?`, `#`, `@`).
 */
export function didWebToUrl(did: string): string | null {
    const DID_WEB = 'did:web:';
    if (!did.startsWith(DID_WEB)) return null;
    const idParts = did.slice(DID_WEB.length).split(':');
    if (!idParts[0]) return null;
    // decodeURIComponent throws (URIError) on malformed percent-encoding; a bad
    // DID must fail closed as "unresolvable", never crash a caller or the boot gate.
    try {
        const host = decodeURIComponent(idParts[0]);
        const pathParts = idParts.slice(1).map(decodeURIComponent);
        // A smuggled `/`, `\`, `?`, `#`, or `@` (userinfo) would point the fetch
        // somewhere other than the DID's own host — reject it.
        if (escapesHostOrPath(host) || pathParts.some(escapesHostOrPath)) return null;
        const path = pathParts.length > 0 ? `/${pathParts.join('/')}/did.json` : '/.well-known/did.json';
        return `https://${host}${path}`;
    } catch {
        return null;
    }
}

interface DidService {
    id?: string;
    type?: string;
    serviceEndpoint?: unknown;
}

/**
 * Pull the AT Protocol PDS `serviceEndpoint` URL out of a DID document — the
 * entry whose `type` is `AtprotoPersonalDataServer` (or whose `id` ends with
 * `#atproto_pds`). Returns `null` when absent.
 */
export function atprotoPdsEndpoint(doc: unknown): string | null {
    const services = (doc as { service?: DidService[] })?.service;
    if (!Array.isArray(services)) return null;
    for (const svc of services) {
        // A malformed doc may carry null / non-object entries — skip, don't crash.
        if (!svc || typeof svc !== 'object') continue;
        const isPds =
            svc.type === 'AtprotoPersonalDataServer' ||
            (typeof svc.id === 'string' && svc.id.endsWith('#atproto_pds'));
        if (isPds && typeof svc.serviceEndpoint === 'string') return svc.serviceEndpoint;
    }
    return null;
}

/**
 * Why a validation failed, and it is the load-bearing distinction in the whole
 * module.
 *
 *   - **`disproof`** — we reached the DID document and it does not say what the
 *     pin claims. The custody claim is FALSE. Fail closed immediately and evict
 *     any cached answer, because a cached "yes" is now known to be wrong.
 *   - **`unreachable`** — we could not get an answer. This is absence of
 *     evidence, not evidence of absence, and treating it as disproof is what
 *     turns a brief `did:web` outage into an outage of ours. Serve the
 *     last-known-good within a staleness bound instead.
 *
 * The deploy workflow already complains about exactly this conflation: "A
 * deploy can therefore fail for a reason that has nothing to do with this
 * commit — a did:web host being briefly unreachable is enough."
 */
export type AppDidFailureKind = 'disproof' | 'unreachable';

export type AppDidValidation =
    | { ok: true; did: string; pdsEndpoint: string; document: unknown }
    | { ok: false; did: string; reason: string; kind: AppDidFailureKind };

/**
 * Classify an HTTP status on the DID document fetch.
 *
 * **404/410 is disproof**: the server answered, definitively, that there is no
 * document at the address the DID names. That is a real answer about the DID.
 *
 * **Every other non-2xx is unreachable**, including 401/403/429. Those are
 * refusals to answer rather than answers — a rate limiter or a WAF in front of
 * the DID host tells us nothing about custody, and failing closed on one would
 * hand any intermediary the ability to take a tenant offline. 5xx likewise.
 */
function classifyHttpStatus(status: number): AppDidFailureKind {
    return status === 404 || status === 410 ? 'disproof' : 'unreachable';
}

/**
 * Resolve + validate an app `did:web` against the four-point pinning contract:
 * fetch the DID document, confirm its `id`, require an `#atproto_pds` endpoint,
 * and — when an expected host is configured — require that endpoint to point at
 * Antiphony (the "custody claim is true" check). Returns the document snapshot
 * on success. Off the hot path; call at boot / onboarding.
 */
export async function validateAppDid(
    did: string,
    opts: { expectedPdsHost?: string; fetchImpl?: typeof fetch } = {},
): Promise<AppDidValidation> {
    const url = didWebToUrl(did);
    // A DID that cannot be turned into a URL at all is malformed, not offline.
    if (!url) return { ok: false, did, reason: 'not-did-web', kind: 'disproof' };
    const doFetch = opts.fetchImpl ?? fetch;
    let doc: unknown;
    try {
        // Time-box the resolve so a hanging did:web endpoint can't block a
        // caller; a timeout throws and is caught below as `unreachable`.
        const res = await doFetch(url, { signal: AbortSignal.timeout(DID_FETCH_TIMEOUT_MS) });
        if (!res.ok) {
            return {
                ok: false,
                did,
                reason: `did-doc-http-${res.status}`,
                kind: classifyHttpStatus(res.status),
            };
        }
        doc = await res.json();
    } catch (err) {
        // Network error, timeout, or a body that would not parse as JSON. The
        // last one is arguably malformed rather than absent, but in practice it
        // is what an intercepting proxy's HTML error page looks like — which is
        // an outage wearing a document's clothes, so it is treated as one.
        return {
            ok: false,
            did,
            reason: `did-doc-fetch-failed: ${(err as Error).message}`,
            kind: 'unreachable',
        };
    }
    // Everything below here read the real document. Any failure is the document
    // contradicting the pin, which is disproof.
    if ((doc as { id?: string })?.id !== did) {
        return { ok: false, did, reason: 'did-doc-id-mismatch', kind: 'disproof' };
    }
    const pdsEndpoint = atprotoPdsEndpoint(doc);
    if (!pdsEndpoint) {
        return { ok: false, did, reason: 'no-atproto-pds-endpoint', kind: 'disproof' };
    }
    if (opts.expectedPdsHost) {
        let host: string;
        try {
            host = new URL(pdsEndpoint).host;
        } catch {
            return { ok: false, did, reason: 'pds-endpoint-unparseable', kind: 'disproof' };
        }
        if (host !== opts.expectedPdsHost) {
            return {
                ok: false,
                did,
                reason: `pds-endpoint-host-mismatch: ${host} != ${opts.expectedPdsHost}`,
                kind: 'disproof',
            };
        }
    }
    return { ok: true, did, pdsEndpoint, document: doc };
}

// --- Boot snapshot (the connective tissue) ----------------------------------

/** A pin that passed validation, with the resolved snapshot kept for diagnostics/drift. */
export interface ValidatedPin {
    originAppId: string;
    did: string;
    pdsEndpoint: string;
    document: unknown;
    /**
     * When the custody proof was last actually obtained, in epoch millis.
     *
     * Deliberately NOT refreshed when a stale entry is served through an
     * outage. If serving stale bumped this, a permanently unreachable DID
     * document would be served forever — the staleness bound would keep
     * resetting and never expire, which is the opposite of what it is for.
     */
    validatedAt: number;
    /**
     * Epoch millis before which no re-resolution is attempted, set only after a
     * transient failure.
     *
     * Without it, an unreachable `did:web` host makes every request pay the
     * full 5s fetch timeout before being served from the stale snapshot — so
     * "the DID host is slow" becomes "our API is slow", which is most of the
     * damage the stale-tolerance was added to prevent. The spec's "retry on the
     * next request" is right about the intent and too eager about the rate.
     */
    retryNotBefore?: number;
}

/**
 * The validated snapshot. Populated wholesale by `validateAllPins()` at boot
 * under Node, and per tenant by `ensureTenantPin()` on Workers, which have no
 * boot phase. `null` until either has run — `getAppDid()` throws in that window
 * rather than serve an unvalidated pin, so a missed gate fails loud instead of
 * silently degrading to plain-env behavior.
 */
let validatedPins: Map<string, ValidatedPin> | null = null;

// --- Layered per-tenant validation (the Workers boot-gate replacement) -------

/**
 * How long a validated pin is served before it is rechecked.
 *
 * Worth being precise about what this replaces, because it reads like a
 * weakening and is not. The Cloud Run gate validates once at process start and
 * serves that answer for the life of the process — thirty days, if the process
 * lives thirty days. So the property it delivers is not "we have proven
 * custody", it is "we had proven custody at process start". A one-hour recheck
 * is *strictly stronger* than that on any long-lived instance.
 */
const PIN_FRESH_MS = 60 * 60 * 1000;

/**
 * How long a last-known-good pin may be served while the DID document is
 * unreachable.
 *
 * This is the bound on the `unreachable` branch, and it is what stops "absence
 * of evidence is not evidence of absence" from becoming "we never check again".
 * A day is long enough that no realistic `did:web` outage reaches it and short
 * enough that a genuinely abandoned DID stops being served.
 */
const PIN_STALE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between re-resolution attempts while serving a stale pin. */
const PIN_RETRY_BACKOFF_MS = 60 * 1000;

/**
 * The slice of a Cloudflare KV namespace this module uses.
 *
 * Declared structurally rather than by importing `@cloudflare/workers-types`,
 * for the reasons `adapters/outbound/r2/bucket.ts` sets out. Absent under Node,
 * where the boot gate populates the isolate-local layer instead and there is
 * only one process to share between.
 */
export interface PinCacheKV {
    get(key: string, type: 'json'): Promise<unknown | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface EnsurePinOptions {
    expectedPdsHost?: string;
    /** Shared across isolates, so a cold one need not re-fetch what a warm one proved. */
    kv?: PinCacheKV;
    fetchImpl?: typeof fetch;
    /** Injectable clock, for tests. */
    now?: () => number;
}

const kvKey = (originAppId: string) => `pin:${originAppId}`;

/** A KV round trip must never be the reason a request fails. */
async function readKvPin(kv: PinCacheKV, originAppId: string): Promise<ValidatedPin | null> {
    try {
        const raw = (await kv.get(kvKey(originAppId), 'json')) as ValidatedPin | null;
        return raw && typeof raw.validatedAt === 'number' ? raw : null;
    } catch (err) {
        logger.warn({ err, originAppId }, '[app-did] pin cache read failed; resolving directly');
        return null;
    }
}

async function writeKvPin(kv: PinCacheKV, pin: ValidatedPin): Promise<void> {
    try {
        await kv.put(kvKey(pin.originAppId), JSON.stringify(pin), {
            // Expire on the STALENESS bound, not the freshness one. KV is the
            // last-known-good store; an entry past `PIN_FRESH_MS` is still
            // useful as the thing to fall back on when the DID host is down,
            // and evicting it at one hour would throw that away precisely when
            // it is needed.
            expirationTtl: Math.floor(PIN_STALE_TOLERANCE_MS / 1000),
        });
    } catch (err) {
        logger.warn({ err, originAppId: pin.originAppId }, '[app-did] pin cache write failed');
    }
}

function remember(pin: ValidatedPin): void {
    validatedPins ??= new Map();
    validatedPins.set(pin.originAppId, pin);
}

/**
 * Prove custody for ONE tenant, from cache when possible, and make the result
 * available to the synchronous `getAppDid`.
 *
 * This is the Workers replacement for the fail-closed boot gate, and it is
 * called from the auth middleware — `requireAuth` and `requireServiceToken`
 * already resolve `originAppId`, they are the tenancy boundary, and a pin is a
 * tenancy property. Putting it there rather than in a fourth middleware avoids
 * an ordering constraint between them, and means that by the time any handler
 * runs the snapshot is populated and **`getAppDid()` stays synchronous** — which
 * is what keeps `AudioPostService` and `AudioProcessingService` from having to
 * become async for no benefit.
 *
 * Three layers, cheapest first:
 *
 *   1. **Isolate-local** — the `validatedPins` map. A warm isolate pays nothing.
 *   2. **KV** — shared across isolates, so a cold isolate does not re-resolve a
 *      document another isolate proved a minute ago.
 *   3. **Resolve** — the actual `did:web` fetch.
 *
 * **Blast radius is per tenant.** `validateAllPins` throws on the first
 * failure, so one bad pin fails the whole boot and takes every other tenant
 * down with it. This 503s the offending tenant and leaves the rest serving.
 *
 * Throws on failure; the caller turns that into a refusal.
 */
export async function ensureTenantPin(
    originAppId: string,
    opts: EnsurePinOptions = {},
): Promise<void> {
    const now = opts.now?.() ?? Date.now();

    const local = validatedPins?.get(originAppId);
    if (local && now - local.validatedAt < PIN_FRESH_MS) return;
    // Backing off after a transient failure. The entry is stale but within
    // tolerance (checked when the backoff was set), so serving it is the same
    // decision already made, just without re-paying the fetch timeout.
    if (local && local.retryNotBefore !== undefined && now < local.retryNotBefore) return;

    const did = parseAppDids().get(originAppId);
    if (!did) {
        // Not a cache miss — this tenant has no pin at all. Fail closed: an
        // `at://` uri cannot be well-formed without a proven DID authority.
        throw new Error(`[app-did] no app DID pinned for tenant "${originAppId}"`);
    }

    if (!local && opts.kv) {
        const cached = await readKvPin(opts.kv, originAppId);
        // `cached.did === did` guards the case that matters: the pin was
        // repointed in config since the cache was written, so the cached proof
        // is about a DID this deployment no longer claims.
        if (cached && cached.did === did && now - cached.validatedAt < PIN_FRESH_MS) {
            remember(cached);
            return;
        }
    }

    const result = await validateAppDid(did, {
        expectedPdsHost: opts.expectedPdsHost,
        fetchImpl: opts.fetchImpl,
    });

    if (result.ok) {
        const pin: ValidatedPin = {
            originAppId,
            did: result.did,
            pdsEndpoint: result.pdsEndpoint,
            document: result.document,
            validatedAt: now,
        };
        remember(pin);
        if (opts.kv) await writeKvPin(opts.kv, pin);
        return;
    }

    if (result.kind === 'disproof') {
        // The custody claim is known false. Evict everywhere — a cached "yes"
        // is now a cached wrong answer — and refuse.
        validatedPins?.delete(originAppId);
        if (opts.kv) await opts.kv.delete(kvKey(originAppId)).catch(() => undefined);
        logger.error(
            { originAppId, did, reason: result.reason },
            '[app-did] custody DISPROVED — evicting and failing closed',
        );
        throw new Error(`[app-did] pin validation failed for tenant "${originAppId}": ${result.reason}`);
    }

    // Unreachable. Fall back to the last known good, from either layer, even if
    // it is past `PIN_FRESH_MS` — that is the entire point of keeping it.
    const lastGood = local ?? (opts.kv ? await readKvPin(opts.kv, originAppId) : null);
    if (lastGood && lastGood.did === did && now - lastGood.validatedAt < PIN_STALE_TOLERANCE_MS) {
        logger.warn(
            {
                originAppId,
                did,
                reason: result.reason,
                staleForMs: now - lastGood.validatedAt,
            },
            '[app-did] did:web unreachable — serving the last proven custody snapshot',
        );
        // `validatedAt` carried over deliberately, so the staleness bound keeps
        // counting from the last real proof rather than restarting here.
        remember({ ...lastGood, retryNotBefore: now + PIN_RETRY_BACKOFF_MS });
        return;
    }

    logger.error(
        { originAppId, did, reason: result.reason },
        '[app-did] did:web unreachable and no usable snapshot — failing closed',
    );
    throw new Error(
        `[app-did] cannot prove custody for tenant "${originAppId}": ${result.reason}`,
    );
}

/**
 * Revalidate every configured pin, off the request path, purely to report.
 *
 * This is the mechanism that actually delivers ongoing custody — the property
 * the boot gate only ever checked by accident, when a process happened to
 * restart. Driven by the Worker's hourly Cron Trigger, which also matters on a
 * low-traffic service: lazy validation alone might not re-check a quiet tenant
 * for a long time, and revocation is exactly what you want to notice quickly.
 *
 * Reports rather than throws. Nothing is serving this call, and a pin that has
 * genuinely drifted will fail closed on its own at the next request through
 * `ensureTenantPin`. Returns the drifted tenants for the caller to log or alert
 * on.
 */
export async function revalidateAllPins(
    opts: EnsurePinOptions = {},
): Promise<{ originAppId: string; did: string; reason: string; kind: AppDidFailureKind }[]> {
    const drift: { originAppId: string; did: string; reason: string; kind: AppDidFailureKind }[] = [];
    for (const [originAppId, did] of parseAppDids()) {
        const result = await validateAppDid(did, {
            expectedPdsHost: opts.expectedPdsHost,
            fetchImpl: opts.fetchImpl,
        });
        if (result.ok) {
            const pin: ValidatedPin = {
                originAppId,
                did: result.did,
                pdsEndpoint: result.pdsEndpoint,
                document: result.document,
                validatedAt: opts.now?.() ?? Date.now(),
            };
            remember(pin);
            if (opts.kv) await writeKvPin(opts.kv, pin);
            continue;
        }
        drift.push({ originAppId, did, reason: result.reason, kind: result.kind });
        if (result.kind === 'disproof') {
            validatedPins?.delete(originAppId);
            if (opts.kv) await opts.kv.delete(kvKey(originAppId)).catch(() => undefined);
        }
    }
    return drift;
}

/**
 * Validate every configured pin against the four-point contract and snapshot
 * the results in memory. **Fail-closed:** a single tenant that doesn't validate
 * rejects the whole boot (throws), so the process never serves `at://` uris
 * whose authority we haven't proven points back at us.
 *
 * Call once at boot, before serving traffic. Re-running re-validates and
 * replaces the snapshot (the eventual onboarding/drift path re-enters here).
 * An empty pin set is valid (no tenants configured yet) and yields an empty
 * snapshot — `getAppDid` then throws per-tenant, not globally.
 */
export async function validateAllPins(
    opts: { expectedPdsHost?: string; fetchImpl?: typeof fetch; raw?: string } = {},
): Promise<Map<string, ValidatedPin>> {
    const pins = parseAppDids(opts.raw);
    const snapshot = new Map<string, ValidatedPin>();
    for (const [originAppId, did] of pins) {
        const result = await validateAppDid(did, {
            expectedPdsHost: opts.expectedPdsHost,
            fetchImpl: opts.fetchImpl,
        });
        if (!result.ok) {
            throw new Error(
                `[app-did] pin validation failed for tenant "${originAppId}" (${did}): ${result.reason}`,
            );
        }
        snapshot.set(originAppId, {
            originAppId,
            did: result.did,
            pdsEndpoint: result.pdsEndpoint,
            document: result.document,
            validatedAt: Date.now(),
        });
    }
    validatedPins = snapshot;
    logger.info(
        { tenants: Array.from(snapshot.keys()) },
        '[app-did] validated + snapshotted app-DID pins',
    );
    return snapshot;
}

/**
 * The validated app DID for a tenant, served from the boot snapshot. Throws
 * when the snapshot is missing (boot validation never ran) or the tenant is
 * absent (unpinned, or failed validation). A post `at://` uri cannot be
 * well-formed without a proven DID authority, so this is fail-closed — the sync
 * accessor every call site resolves `record.originAppId` through.
 */
export function getAppDid(originAppId: string): string {
    if (validatedPins === null) {
        throw new Error('[app-did] app-DID pins not validated; call validateAllPins() at boot');
    }
    const pin = validatedPins.get(originAppId);
    if (!pin) {
        throw new Error(`[app-did] no validated app DID for tenant "${originAppId}"`);
    }
    return pin.did;
}

/** The full validated snapshot for a tenant (document + pds endpoint), or `null`. */
export function getValidatedPin(originAppId: string): ValidatedPin | null {
    return validatedPins?.get(originAppId) ?? null;
}

/**
 * Cross-check the two per-tenant registries that must agree for a tenant to
 * work end-to-end: auth tokens (`ANTIPHONY_APP_TOKENS`: originAppId → token)
 * and app-DID pins (`ANTIPHONY_APP_DIDS`: originAppId → app DID). A tenant in
 * one but not the other is config drift:
 *  - **token, no pin** — it can authenticate, but every post write/read fails
 *    closed (`getAppDid` throws) since we can't build its `at://` authority.
 *  - **pin, no token** — the validated pin is unreachable (nothing authenticates
 *    into that tenancy).
 *
 * Logged as **warnings, not fatal**: an app may legitimately authenticate
 * without touching the posts surface, and one tenant's gap must not down the
 * whole deploy (unlike a *bad* pin, which `validateAllPins` fails closed on).
 * Takes the token app-ids as a param so this module stays decoupled from
 * `service-auth`. Call at boot after `validateAllPins()`; returns the drift for
 * diagnostics/tests.
 */
export function checkTenantRegistryDrift(tokenAppIds: Iterable<string>): {
    tokensWithoutPin: string[];
    pinsWithoutToken: string[];
} {
    const tokens = new Set(tokenAppIds);
    const pins = new Set(validatedPins?.keys() ?? []);
    const tokensWithoutPin = [...tokens].filter((id) => !pins.has(id));
    const pinsWithoutToken = [...pins].filter((id) => !tokens.has(id));
    for (const originAppId of tokensWithoutPin) {
        logger.warn(
            { originAppId },
            '[app-did] tenant has an auth token but no validated app-DID pin — it can authenticate but every post read/write fails closed; add it to ANTIPHONY_APP_DIDS',
        );
    }
    for (const originAppId of pinsWithoutToken) {
        logger.warn(
            { originAppId },
            '[app-did] tenant has an app-DID pin but no auth token — the pin is unreachable; add it to ANTIPHONY_APP_TOKENS or drop the pin',
        );
    }
    return { tokensWithoutPin, pinsWithoutToken };
}

/** Test-only: clear the in-memory snapshot so each test starts from an unvalidated state. */
export function resetValidatedPinsForTest(): void {
    validatedPins = null;
}
