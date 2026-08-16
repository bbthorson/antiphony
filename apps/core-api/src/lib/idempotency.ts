import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { firebaseIdempotencyStore } from '../adapters/outbound/firebase/idempotency-store.js';
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
 * The key is client-supplied, so it can contain anything — including `/`
 * (which Firestore interprets as a path separator, writing the doc into a
 * subcollection / failing the read) or `.`/`..` (reserved doc IDs). Hashing
 * the key to fixed-length hex makes the ID path-safe and bounded regardless of
 * input, and SHA-256 keeps it collision-resistant. The `uid` prefix namespaces
 * it per-caller (so the same raw key from two users never collides), and is
 * kept readable for debuggability.
 */
function docId(uid: string, key: string): string {
    return `${uid}_${createHash('sha256').update(key).digest('hex')}`;
}

export async function checkIdempotency(
    c: Context,
    uid: string,
    store: IdempotencyStore = firebaseIdempotencyStore,
): Promise<{ cached: unknown } | null> {
    const key = readKey(c);
    if (!key) return null;

    const claim = await store.claim(docId(uid, key), TTL_MS);
    if (claim === 'in-progress') throw new IdempotencyInProgressError();
    if (claim === 'claimed') return null;
    return { cached: claim.replay };
}

export async function saveIdempotencyResult(
    c: Context,
    uid: string,
    body: unknown,
    store: IdempotencyStore = firebaseIdempotencyStore,
): Promise<void> {
    const key = readKey(c);
    if (!key) return;
    await store.settle(docId(uid, key), body, TTL_MS);
}
