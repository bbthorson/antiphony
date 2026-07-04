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

export type AppDidValidation =
    | { ok: true; did: string; pdsEndpoint: string; document: unknown }
    | { ok: false; did: string; reason: string };

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
    if (!url) return { ok: false, did, reason: 'not-did-web' };
    const doFetch = opts.fetchImpl ?? fetch;
    let doc: unknown;
    try {
        // Time-box the resolve so a hanging did:web endpoint can't block boot;
        // a timeout throws and is caught below, failing the pin closed.
        const res = await doFetch(url, { signal: AbortSignal.timeout(DID_FETCH_TIMEOUT_MS) });
        if (!res.ok) return { ok: false, did, reason: `did-doc-http-${res.status}` };
        doc = await res.json();
    } catch (err) {
        return { ok: false, did, reason: `did-doc-fetch-failed: ${(err as Error).message}` };
    }
    if ((doc as { id?: string })?.id !== did) {
        return { ok: false, did, reason: 'did-doc-id-mismatch' };
    }
    const pdsEndpoint = atprotoPdsEndpoint(doc);
    if (!pdsEndpoint) return { ok: false, did, reason: 'no-atproto-pds-endpoint' };
    if (opts.expectedPdsHost) {
        let host: string;
        try {
            host = new URL(pdsEndpoint).host;
        } catch {
            return { ok: false, did, reason: 'pds-endpoint-unparseable' };
        }
        if (host !== opts.expectedPdsHost) {
            return { ok: false, did, reason: `pds-endpoint-host-mismatch: ${host} != ${opts.expectedPdsHost}` };
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
}

/**
 * The validated snapshot, populated by `validateAllPins()` at boot. `null`
 * until then — `getAppDid()` throws in that window rather than serve an
 * unvalidated pin, so a missed boot gate fails loud instead of silently
 * degrading to plain-env behavior.
 */
let validatedPins: Map<string, ValidatedPin> | null = null;

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
