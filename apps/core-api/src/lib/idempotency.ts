import admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { getAdminDb } from './firebase-admin.js';

/**
 * Idempotency-Key support for write endpoints. Mirrors apps/web's
 * `checkIdempotency` / `saveIdempotencyResult`.
 *
 * Flow:
 *   1. Handler calls `checkIdempotency(c, uid)`.
 *      - returns `{ cached: <response> }` → handler returns that directly (200)
 *      - returns `null` → proceed, the key is marked `processing`
 *      - throws `IdempotencyInProgressError` → two concurrent requests;
 *        handler returns 409
 *   2. Handler performs the work.
 *   3. Handler calls `saveIdempotencyResult(c, uid, body)` before responding.
 *
 * Storage: Firestore `idempotency_keys/{uid}_{sha256(key)}` with `{status,
 * response, createdAt, completedAt, expiresAt}`. 24h TTL.
 *
 * The doc ID is namespaced by `uid` so that two different callers sending the
 * same raw key value get independent idempotency records. Without this, the
 * first user's cached response could be returned to a second user (resource-id
 * leak), or a second user could pre-register a key and force a spurious 409
 * for the first user (write denial).
 *
 * The header is read case-insensitively. `null` return when no header — the
 * caller proceeds without any idempotency behavior (matches apps/web).
 */

const COLLECTION = 'idempotency_keys';
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
): Promise<{ cached: unknown } | null> {
    const key = readKey(c);
    if (!key) return null;

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(docId(uid, key));

    const result = await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (doc.exists) {
            const data = doc.data();
            const createdMs = (data?.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.();
            // Expired keys: treat as a new request. Overwrites the prior
            // record with a fresh processing marker.
            if (createdMs && Date.now() - createdMs > TTL_MS) {
                t.set(docRef, {
                    status: 'processing',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS),
                });
                return null;
            }
            if (data?.status === 'processing') {
                throw new IdempotencyInProgressError();
            }
            if (data?.status === 'completed') {
                return { cached: data.response };
            }
            return null;
        }
        // First time we've seen the key — mark as processing.
        t.set(docRef, {
            status: 'processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS),
        });
        return null;
    });

    return result;
}

export async function saveIdempotencyResult(c: Context, uid: string, body: unknown): Promise<void> {
    const key = readKey(c);
    if (!key) return;

    const db = getAdminDb();
    await db
        .collection(COLLECTION)
        .doc(docId(uid, key))
        .set(
            {
                status: 'completed',
                response: body,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS),
            },
            { merge: true },
        );
}
