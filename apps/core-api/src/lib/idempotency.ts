import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { servicesFor } from '../composition.js';
import type { IdempotencyStore } from '../ports/idempotency-store.js';

/**
 * `Idempotency-Key` support for write endpoints.
 *
 * Flow:
 *   1. Handler calls `checkIdempotency(c, uid)`.
 *      - returns `{ cached: <response> }` → handler returns that directly (200)
 *      - returns `null` → proceed, the key is marked in-flight
 *      - throws `IdempotencyInProgressError` → two concurrent requests;
 *        handler returns 409
 *   2. Handler performs the work.
 *   3. Handler calls `saveIdempotencyResult(c, uid, body)` before responding.
 *
 * Storage sits behind `IdempotencyStore` (ports/idempotency-store.ts). What
 * stays HERE is the part that is HTTP contract rather than storage: reading the
 * header case-insensitively, deriving a per-caller id from it, and the 24h TTL.
 *
 * The doc id is namespaced by `uid` so two callers sending the same raw key get
 * independent records. Without it, the first caller's cached response could be
 * returned to a second (resource-id leak), or a second could pre-register a key
 * and force a spurious 409 for the first (write denial).
 *
 * ## The store comes from the composition root, not from a default argument
 *
 * It used to default to the Firestore store, and no caller ever passed
 * anything else — so the Postgres binding that landed in #86 was unreachable in
 * production no matter how the deployment was configured, and the import made
 * `firebase-admin` reachable from every write route. Resolving it per request
 * off `c.env` fixed both. The Firestore store is gone now, but the resolution
 * stays as it is: a default store is what made a binding unreachable by
 * configuration, and nothing about that depends on which store it defaulted
 * to.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

export class IdempotencyInProgressError extends Error {
    constructor() {
        super('Request already in progress');
        this.name = 'IdempotencyInProgressError';
    }
}

function readKey(c: Context): string | null {
    const header = c.req.header('idempotency-key');
    if (!header || !header.trim()) return null;
    return header.trim();
}

/**
 * Build a per-user doc ID from the raw client key.
 *
 * The key is client-supplied, so it can contain anything. Firestore made that
 * acutely dangerous — `/` was a path separator and `.`/`..` were reserved doc
 * ids — and Postgres has no such rule, but the id is still a primary key built
 * from hostile input. Hashing to fixed-length hex keeps it bounded and flat
 * regardless of what arrives, and SHA-256 keeps it collision-resistant. The
 * `uid` prefix namespaces it per-caller (so the same raw key from two users
 * never collides), and is kept readable for debuggability.
 */
function docId(uid: string, key: string): string {
    return `${uid}_${createHash('sha256').update(key).digest('hex')}`;
}

/** This request's store: the composed one, unless a caller names another. */
function resolveStore(c: Context, store?: IdempotencyStore): IdempotencyStore {
    return store ?? servicesFor(c.env as Record<string, unknown> | undefined).idempotencyStore;
}

export async function checkIdempotency(
    c: Context,
    uid: string,
    store?: IdempotencyStore,
): Promise<{ cached: unknown } | null> {
    const key = readKey(c);
    if (!key) return null;

    const claim = await resolveStore(c, store).claim(docId(uid, key), TTL_MS);
    if (claim === 'in-progress') throw new IdempotencyInProgressError();
    if (claim === 'claimed') return null;
    return { cached: claim.replay };
}

export async function saveIdempotencyResult(
    c: Context,
    uid: string,
    body: unknown,
    store?: IdempotencyStore,
): Promise<void> {
    const key = readKey(c);
    if (!key) return;
    await resolveStore(c, store).settle(docId(uid, key), body, TTL_MS);
}
