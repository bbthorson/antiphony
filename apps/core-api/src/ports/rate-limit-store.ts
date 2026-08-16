/**
 * `RateLimitStore` — the backend seam for rate-limit buckets.
 *
 * ## Why this port lives in `apps/core-api`, not `packages/core`
 *
 * `packages/core` holds the portable DOMAIN ports, and its guardrail is that a
 * port travels with the service that needs it. No core service rate-limits —
 * this is an HTTP transport concern, reached only from `middleware/rate-limit.ts`.
 * Putting it in the domain package would widen what that package hands out for a
 * consumer that does not exist there.
 *
 * ## The three-state outcome, and why it is not an error taxonomy
 *
 * The obvious port shape is `hit(): Promise<boolean>` plus exceptions, letting the
 * caller classify failures. That was rejected: the classification the Firestore
 * implementation performs is *gRPC status codes* (`ABORTED` = 10,
 * `FAILED_PRECONDITION` = 9 ⇒ per-bucket contention, fail closed; everything else
 * ⇒ systemic, fail open), and those codes are meaningless to any other backend.
 *
 * More decisively, **the Postgres binding cannot have that failure at all.** Its
 * check is a single upsert (`INSERT … ON CONFLICT DO UPDATE`), which has no
 * read-then-write window to abort in. The contention branch the Firestore
 * implementation must handle simply does not exist there, so an abstraction
 * modelling it would be one binding's implementation detail promoted to a
 * contract that another binding can only ever leave unused.
 *
 * So the port answers the narrowest question that is true for every backend:
 *
 *   - `over`      — this bucket has met or exceeded its limit. Refuse.
 *   - `under`     — it has not. Proceed.
 *   - `unavailable` — the store could not answer. **The caller decides.**
 *
 * Each binding maps its own failures onto those three. Firestore folds
 * per-bucket contention into `over` (a bucket too contended to read is, by
 * definition, being hammered — which is what the limiter exists to catch) and
 * everything else into `unavailable`. A future Postgres binding has no
 * contention case and maps connection/query failure to `unavailable`.
 *
 * ## What deliberately stays OUT of the port
 *
 * The circuit breaker and the fail-open policy. Those answer "is the backend
 * healthy, and what should we do while it isn't" — a question about the
 * deployment, not about the store, and identical whichever store is wired.
 * Keeping them above the seam means the policy is unit-testable with no backend
 * at all, and a new binding inherits it rather than reimplementing it. This is
 * the part most at risk of being quietly lost in a port, because in the
 * Firestore implementation the policy and the storage were one function.
 */

export interface RateLimitWindow {
    /** Maximum hits permitted within `windowMs`. */
    limit: number;
    /** Window length in milliseconds. */
    windowMs: number;
}

/**
 * The store's answer for one bucket hit.
 *
 * `unavailable` is deliberately not an exception: an unreachable store is an
 * expected operating condition for a rate limiter (it is why the circuit
 * breaker exists), and making the caller's most important branch a `catch`
 * invites it being written as a bare rethrow. As a return value it is
 * impossible to overlook — the caller cannot destructure the result without
 * confronting it.
 */
export type RateLimitOutcome = 'over' | 'under' | 'unavailable';

export interface RateLimitStore {
    /**
     * Record one hit against `key` and report whether the bucket is now over
     * its limit.
     *
     * **Counts the hit as part of the check.** Reporting and incrementing must
     * be one operation, or two concurrent requests both read an under-limit
     * count and both proceed.
     *
     * A bucket whose window has closed resets rather than accumulating, so
     * `key` never needs explicit clearing. Expiry cleanup is the binding's
     * concern (Firestore TTL; a sweep on Postgres — see db/schema.sql).
     *
     * Must not throw for an unreachable backend — return `'unavailable'`.
     * Throwing is reserved for programmer error (a malformed key, a missing
     * binding), which is not something the circuit breaker should absorb.
     */
    hit(key: string, window: RateLimitWindow): Promise<RateLimitOutcome>;
}
