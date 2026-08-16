/**
 * `IdempotencyStore` — the backend seam for `Idempotency-Key` records.
 *
 * Lives in `apps/core-api` rather than `packages/core` for the same reason as
 * `rate-limit-store.ts`: no domain service is idempotency-aware, and the only
 * consumer is `lib/idempotency.ts` on the HTTP write path.
 *
 * ## The claim/settle shape
 *
 * Two methods, mirroring the two moments a write endpoint has:
 *
 *   1. `claim(id)` before doing the work — atomically registers the key as
 *      in-flight and reports what was already there.
 *   2. `settle(id, response)` after — records the response for replay.
 *
 * `claim` must be **atomic**, and that is the whole reason this is a port
 * method rather than a `get` plus a `put` the caller composes. Two concurrent
 * requests carrying the same key must not both see "absent" and both proceed;
 * the check and the registration are one operation or the guarantee is void.
 * Firestore does it in a transaction; Postgres does it as
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`.
 *
 * ## Expiry is the store's business, not the caller's
 *
 * `claim` on an EXPIRED record must behave exactly as `claim` on an absent one
 * — reclaim it and return `'claimed'`. The alternative (surfacing the expiry to
 * the caller) leaks a storage concern into the handler and gives every future
 * binding a chance to get the comparison subtly wrong. The TTL itself is passed
 * in so the policy stays with the caller that owns the contract.
 */

/**
 * What `claim` found.
 *
 *   - `claimed`     — the key was absent (or expired); it is now registered as
 *                     in-flight and the caller should do the work.
 *   - `in-progress` — another request holds this key right now. The caller
 *                     should refuse with 409 rather than duplicating the work.
 *   - `{ replay }`  — the key completed previously; `replay` is the stored
 *                     response body and the caller should return it verbatim.
 */
export type IdempotencyClaim =
    | 'claimed'
    | 'in-progress'
    | { replay: unknown };

export interface IdempotencyStore {
    /**
     * Atomically claim `id`, reporting what was already recorded under it.
     *
     * `ttlMs` applies to the claim being made: a record older than this is
     * treated as absent and reclaimed. It is a parameter rather than store
     * config so the HTTP contract's 24h window is stated where that contract
     * lives, and two callers could use different windows without a second
     * store.
     */
    claim(id: string, ttlMs: number): Promise<IdempotencyClaim>;

    /**
     * Record the completed response for `id` so a later `claim` replays it.
     *
     * Best-effort by contract: the work has already succeeded by the time this
     * is called, so a failure here must not fail the request. It costs a
     * duplicate execution if the client retries — strictly better than failing
     * a write that already happened. Callers are expected to swallow, and
     * bindings should not throw for transient backend trouble.
     */
    settle(id: string, response: unknown, ttlMs: number): Promise<void>;
}
