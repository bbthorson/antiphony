import { getAdminDb, getAdmin } from '../../../lib/firebase-admin.js';
import { logger } from '../../../lib/logger.js';
import type {
    RateLimitOutcome,
    RateLimitStore,
    RateLimitWindow,
} from '../../../ports/rate-limit-store.js';

/**
 * Firestore-backed `RateLimitStore`. Buckets live in `rate_limits`, keyed by
 * the caller-supplied key, with TTL cleanup driven by `expiresAt` (see
 * firestore.indexes.json).
 *
 * Extracted verbatim from `middleware/rate-limit.ts`; the transaction body and
 * the error classification below are unchanged. What moved OUT is the circuit
 * breaker and the fail-open decision, which are deployment policy rather than
 * storage — see ports/rate-limit-store.ts for why that split is where it is.
 */

/** Grace period after a window closes before the bucket is TTL-eligible. */
const TTL_BUFFER_MS = 60 * 60 * 1000;

/**
 * Whether a thrown Firestore error is per-bucket contention rather than a
 * systemic outage.
 *
 * gRPC codes, checked structurally because the Admin SDK does not export its
 * error hierarchy:
 *   - ABORTED (10) — transaction conflict. Expected under concurrent writes to
 *     the SAME bucket.
 *   - FAILED_PRECONDITION (9) — stale transaction data. Same cause.
 *   - DEADLINE_EXCEEDED (4) — ambiguous; could be either. Deliberately treated
 *     as systemic, since it is rare enough not to be worth tolerating quietly.
 *   - everything else (UNAVAILABLE, INTERNAL, …) — systemic.
 */
function isPerBucketContention(error: unknown): boolean {
    const code = (error as { code?: number | string } | null)?.code;
    return (
        code === 10 ||
        code === 'ABORTED' ||
        code === 9 ||
        code === 'FAILED_PRECONDITION'
    );
}

export const firebaseRateLimitStore: RateLimitStore = {
    async hit(key: string, window: RateLimitWindow): Promise<RateLimitOutcome> {
        const db = getAdminDb();
        const admin = getAdmin();
        const docRef = db.collection('rate_limits').doc(key);
        const now = Date.now();

        try {
            const isLimited = await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);
                const data = doc.data();

                if (!doc.exists || (data && now > data.resetTime)) {
                    const resetTime = now + window.windowMs;
                    const expiresAt = admin.firestore.Timestamp.fromMillis(
                        resetTime + TTL_BUFFER_MS,
                    );
                    t.set(docRef, { count: 1, resetTime, expiresAt });
                    return false;
                }
                if (data && data.count >= window.limit) {
                    return true;
                }
                t.update(docRef, { count: (data?.count ?? 0) + 1 });
                return false;
            });

            return isLimited ? 'over' : 'under';
        } catch (error: unknown) {
            if (isPerBucketContention(error)) {
                // Reported as `over`, not `unavailable`, and the distinction is
                // load-bearing: `unavailable` feeds the circuit breaker, and a
                // single caller hammering their OWN bucket could then trip it
                // and fail-open rate limiting for everyone. The Admin SDK has
                // already retried internally by this point, so reaching here
                // means genuine concurrent pressure on one key — which is
                // precisely what the limiter exists to refuse.
                //
                // Trade-off, unchanged from the original: legitimate bursts
                // from a shared-NAT IP get 429s under contention. Acceptable —
                // they ARE exceeding the per-IP rate, and the alternative lets
                // an attacker bypass the limiter by hammering one bucket.
                logger.warn(
                    { error, key },
                    '[rate-limit] transaction contention on bucket — refusing',
                );
                return 'over';
            }
            logger.error({ error, key }, '[rate-limit] firestore systemic error');
            return 'unavailable';
        }
    },
};
