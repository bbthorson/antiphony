import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';

/**
 * Service-token registry for app (service-to-service) auth — the contract in
 * `specs/service-auth.md`.
 *
 * `ANTIPHONY_APP_TOKENS` holds comma-separated `appId:token` pairs. A caller
 * presenting a matching token is an authenticated APPLICATION: its
 * `originAppId` (tenancy key) comes from the matched entry, and the acting
 * end user arrives as an assertion in `X-Antiphony-Acting-Actor` — Antiphony
 * trusts that assertion within the app's own tenancy.
 *
 * Parsed lazily and cached keyed on the raw env value, so tests and env
 * changes take effect without paying a re-parse on every request. (A registry
 * collection is the planned upgrade path, and this module is the swap point.)
 */

/** Minimum service-token length — same bar as SYSTEM_AUTH_TOKEN. */
const SERVICE_TOKEN_MIN_LENGTH = 32;

export interface ServiceApp {
    appId: string;
    token: string;
}

let cachedApps: ServiceApp[] | null = null;
let cachedRaw: string | undefined;

/**
 * Parse `ANTIPHONY_APP_TOKENS` (`appId:token,appId2:token2`). Entries that
 * are malformed or carry a too-short token are dropped with an error log —
 * fail-closed for that app, never fail-open. An app id MAY appear twice
 * (token rotation window); both tokens then authenticate that app.
 *
 * The result is cached keyed on the raw string, so the hot path pays no
 * re-parse while env changes (tests, restarts) still take effect.
 */
export function parseAppTokens(raw: string | undefined = process.env.ANTIPHONY_APP_TOKENS): ServiceApp[] {
    if (raw === cachedRaw && cachedApps !== null) return cachedApps;
    cachedRaw = raw;
    cachedApps = parseAppTokensUncached(raw);
    return cachedApps;
}

function parseAppTokensUncached(raw: string | undefined): ServiceApp[] {
    if (!raw || !raw.trim()) return [];
    const apps: ServiceApp[] = [];
    for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const appId = sep > 0 ? trimmed.slice(0, sep).trim() : '';
        const token = sep > 0 ? trimmed.slice(sep + 1).trim() : '';
        if (!appId || !token) {
            logger.error({ entry: trimmed.slice(0, 16) }, '[service-auth] malformed ANTIPHONY_APP_TOKENS entry; ignoring');
            continue;
        }
        if (token.length < SERVICE_TOKEN_MIN_LENGTH) {
            logger.error(
                { appId, minLength: SERVICE_TOKEN_MIN_LENGTH, actualLength: token.length },
                '[service-auth] service token too short; ignoring entry (rotate to ≥32 chars)',
            );
            continue;
        }
        apps.push({ appId, token });
    }
    return apps;
}

/**
 * Constant-time string comparison. Hash both sides to fixed-length digests,
 * then compare with the native `crypto.timingSafeEqual` — this eliminates
 * timing leaks entirely (including length leaks) without relying on a
 * hand-rolled loop the JIT could optimize out of constant time.
 */
function constantTimeEqual(a: string, b: string): boolean {
    const aHash = createHash('sha256').update(a).digest();
    const bHash = createHash('sha256').update(b).digest();
    return timingSafeEqual(aHash, bHash);
}

/**
 * Match a presented bearer token against the configured app tokens.
 * Compares against EVERY entry (no early exit) to keep timing flat.
 * Returns the matched app id, or null.
 */
export function matchServiceToken(presented: string): string | null {
    let matched: string | null = null;
    for (const app of parseAppTokens()) {
        if (constantTimeEqual(presented, app.token)) {
            matched ??= app.appId;
        }
    }
    return matched;
}
