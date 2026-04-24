import admin from 'firebase-admin';
import type { Context } from 'hono';
import { getAdminDb } from './firebase-admin.js';

/**
 * Idempotency-Key support for write endpoints. Mirrors apps/web's
 * `checkIdempotency` / `saveIdempotencyResult`.
 *
 * Flow:
 *   1. Handler calls `checkIdempotency(c)`.
 *      - returns `{ cached: <response> }` → handler returns that directly (200)
 *      - returns `null` → proceed, the key is marked `processing`
 *      - throws `IdempotencyInProgressError` → two concurrent requests;
 *        handler returns 409
 *   2. Handler performs the work.
 *   3. Handler calls `saveIdempotencyResult(c, body)` before responding.
 *
 * Storage: Firestore `idempotency_keys/{key}` with `{status, response,
 * createdAt, completedAt, expiresAt}`. 24h TTL.
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

export async function checkIdempotency(
    c: Context,
): Promise<{ cached: unknown } | null> {
    const key = readKey(c);
    if (!key) return null;

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(key);

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

export async function saveIdempotencyResult(c: Context, body: unknown): Promise<void> {
    const key = readKey(c);
    if (!key) return;

    const db = getAdminDb();
    await db
        .collection(COLLECTION)
        .doc(key)
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
