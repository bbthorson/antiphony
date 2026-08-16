import admin from 'firebase-admin';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import type {
    IdempotencyClaim,
    IdempotencyStore,
} from '../../../ports/idempotency-store.js';

/**
 * Firestore-backed `IdempotencyStore`. Records live in `idempotency_keys` under
 * the caller-supplied id, with TTL cleanup driven by `expiresAt` (see
 * firestore.indexes.json).
 *
 * Extracted verbatim from `lib/idempotency.ts`. The transaction body is
 * unchanged; what stayed behind is the HTTP-shaped part — reading the header
 * and hashing it into a per-caller id — which is contract, not storage.
 */

const COLLECTION = 'idempotency_keys';

export const firebaseIdempotencyStore: IdempotencyStore = {
    async claim(id: string, ttlMs: number): Promise<IdempotencyClaim> {
        const db = getAdminDb();
        const docRef = db.collection(COLLECTION).doc(id);

        return db.runTransaction(async (t): Promise<IdempotencyClaim> => {
            const doc = await t.get(docRef);
            const markProcessing = () => {
                t.set(docRef, {
                    status: 'processing',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + ttlMs),
                });
            };

            if (!doc.exists) {
                markProcessing();
                return 'claimed';
            }

            const data = doc.data();
            const createdMs = (
                data?.createdAt as { toMillis?: () => number } | undefined
            )?.toMillis?.();

            // Expired ⇒ indistinguishable from absent, per the port contract.
            // Overwrites the stale record with a fresh processing marker.
            if (createdMs && Date.now() - createdMs > ttlMs) {
                markProcessing();
                return 'claimed';
            }

            if (data?.status === 'processing') return 'in-progress';
            if (data?.status === 'completed') return { replay: data.response };

            // A record with neither status is corrupt rather than meaningful;
            // treat it as absent and reclaim, matching the pre-port behaviour.
            markProcessing();
            return 'claimed';
        });
    },

    async settle(id: string, response: unknown, ttlMs: number): Promise<void> {
        await getAdminDb()
            .collection(COLLECTION)
            .doc(id)
            .set(
                {
                    status: 'completed',
                    response,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + ttlMs),
                },
                { merge: true },
            );
    },
};
