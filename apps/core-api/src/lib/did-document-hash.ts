import { logger } from './logger.js';

/**
 * DID-document drift detection — the fourth point of the pinning contract in
 * `specs/atproto-authority-model.md` (#117):
 *
 * > Treat any observed change to the resolved document as an explicit
 * > re-keying event — surfaced and acknowledged, never silently absorbed.
 *
 * ## The baseline is acknowledged, not observed
 *
 * The pin cache cannot be the baseline. It is last-known-good, and it is
 * overwritten by the very resolution that should have been checked against it
 * — a baseline that updates itself cannot detect anything. So the baseline is a
 * hash committed next to the pin in `wrangler.jsonc`
 * (`ANTIPHONY_APP_DID_DOC_HASHES`), and acknowledging a change is updating that
 * hash in a PR. A re-keying event becomes a diff someone approved.
 *
 * ## Compare a hash of a canonical form
 *
 * Key order and whitespace are not drift. The document is serialized with the
 * JSON Canonicalization Scheme (RFC 8785) before hashing, so two servings of
 * the same document hash the same however the host pretty-prints them.
 * Array order is NOT normalized: JCS preserves it, and the order of
 * `verificationMethod` or `service` entries is the publisher's statement.
 *
 * ## Who does what with a mismatch
 *
 *   - **Deploy gate** (`validate-pins.ts`) fails. That is where acknowledgment
 *     happens, so it is the one place a mismatch should stop anything.
 *   - **Hourly cron** reports and does NOT fail closed. A changed document is
 *     not a disproved custody claim — an additive key rotation (publish the new
 *     key alongside the old, then retire it) is legitimate drift, and taking a
 *     tenant down for doing the right thing would be the wrong default.
 *   - **Signed service auth** will not take a key from a document nobody
 *     acknowledged. The document is a keystore there, and that is the one use
 *     where silently absorbing a change hands an attacker a credential.
 */

/**
 * Serialize a JSON value per RFC 8785 (JCS).
 *
 * Primitives use ECMAScript's own `JSON.stringify`, which is what JCS
 * specifies for both numbers and string escaping; object keys sort by UTF-16
 * code unit, which is exactly what the default `Array.prototype.sort` does on
 * strings. Input is assumed to be parsed JSON — no `undefined`, functions or
 * non-finite numbers, all of which `res.json()` cannot produce.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${members.join(',')}}`;
}

/** `sha256:<hex>` of the canonical document — the form committed as a baseline. */
export async function didDocumentHash(doc: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(doc)));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

let cachedBaselines: Map<string, string> | null = null;
let cachedRaw: string | undefined;

/**
 * Parse `ANTIPHONY_APP_DID_DOC_HASHES` (`appId:sha256:<hex>,…`) into an
 * `originAppId → hash` map. Same shape and first-colon split as
 * `ANTIPHONY_APP_DIDS`. A malformed entry is dropped with an error log, which
 * leaves that tenant with no baseline — the deploy gate then fails on it, so a
 * typo cannot quietly switch the check off.
 */
export function parseDocHashBaselines(
    raw: string | undefined = process.env.ANTIPHONY_APP_DID_DOC_HASHES,
): Map<string, string> {
    if (raw === cachedRaw && cachedBaselines !== null) return cachedBaselines;
    const baselines = new Map<string, string>();
    for (const entry of (raw ?? '').split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const appId = sep > 0 ? trimmed.slice(0, sep).trim() : '';
        const hash = sep > 0 ? trimmed.slice(sep + 1).trim().toLowerCase() : '';
        if (!appId || !HASH_RE.test(hash)) {
            logger.error(
                { entry: trimmed.slice(0, 24) },
                '[did-doc-hash] malformed ANTIPHONY_APP_DID_DOC_HASHES entry; ignoring',
            );
            continue;
        }
        baselines.set(appId, hash);
    }
    cachedRaw = raw;
    cachedBaselines = baselines;
    return baselines;
}

/**
 * How a resolved document compares with the acknowledged baseline.
 *
 * `no-baseline` is kept apart from `changed` because the remedy differs: one is
 * a tenant nobody has acknowledged yet, the other is a document that moved
 * after someone did.
 */
export type DocumentAcknowledgement =
    | { status: 'acknowledged' }
    | { status: 'changed'; expected: string; observed: string }
    | { status: 'no-baseline'; observed: string };

export function documentAcknowledgement(
    originAppId: string,
    observed: string,
    baselines: Map<string, string> = parseDocHashBaselines(),
): DocumentAcknowledgement {
    const expected = baselines.get(originAppId);
    if (expected === undefined) return { status: 'no-baseline', observed };
    return expected === observed ? { status: 'acknowledged' } : { status: 'changed', expected, observed };
}
