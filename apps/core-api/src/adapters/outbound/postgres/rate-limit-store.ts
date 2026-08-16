import { logger } from '../../../lib/logger.js';
import type {
    RateLimitOutcome,
    RateLimitStore,
    RateLimitWindow,
} from '../../../ports/rate-limit-store.js';
import type { SqlClient } from '../../../ports/sql-client.js';

/**
 * Postgres-backed `RateLimitStore`.
 *
 * The Firestore binding needs a transaction: read the bucket, decide, write it
 * back. This is one statement, and the difference is not cosmetic — a
 * read-then-write has a window in which a concurrent request can interleave,
 * which is exactly the contention the Firestore binding must detect and fold
 * into `over`. **That failure mode does not exist here**, which is why
 * `RateLimitOutcome` models three states rather than an error taxonomy (see
 * ports/rate-limit-store.ts).
 *
 * The statement increments and reports in one round trip:
 *
 *   - No row, or a row whose window has closed ⇒ start a fresh window at 1.
 *   - Otherwise ⇒ increment.
 *
 * and returns the post-increment count, which the caller compares to the limit.
 *
 * ## Why the limit is compared HERE and not in SQL
 *
 * The statement could `RETURNING count > $limit`. It does not, because the
 * count is worth having in the log line when a bucket trips, and a boolean
 * discards it. The comparison is one `>=` on a value the round trip already
 * paid for.
 *
 * ## `expires_at` is for the sweep, not for correctness
 *
 * A closed window is detected by `reset_time < now()`, not by the row being
 * absent, so a bucket whose sweep has not run yet behaves identically to one
 * that has been reclaimed. `expires_at` exists solely so
 * `antiphony_sweep_expired()` can reclaim the space (db/schema.sql) — nothing
 * reads it on this path.
 */

/** Grace after a window closes before the row is sweep-eligible. Matches the Firestore TTL buffer. */
const TTL_BUFFER_MS = 60 * 60 * 1000;

const HIT = `
    insert into rate_limits (key, count, reset_time, expires_at)
    values ($1, 1, now() + $2::interval, now() + $2::interval + $3::interval)
    on conflict (key) do update
        set count      = case when rate_limits.reset_time < now() then 1
                              else rate_limits.count + 1 end,
            reset_time = case when rate_limits.reset_time < now() then excluded.reset_time
                              else rate_limits.reset_time end,
            expires_at = case when rate_limits.reset_time < now() then excluded.expires_at
                              else rate_limits.expires_at end
    returning count
`;

/** Postgres interval literal from milliseconds. `$n::interval` needs text, not a number. */
function ms(value: number): string {
    return `${Math.max(0, Math.round(value))} milliseconds`;
}

export function postgresRateLimitStore(sql: SqlClient): RateLimitStore {
    return {
        async hit(key: string, window: RateLimitWindow): Promise<RateLimitOutcome> {
            try {
                const rows = await sql.query<{ count: number }>(HIT, [
                    key,
                    ms(window.windowMs),
                    ms(TTL_BUFFER_MS),
                ]);
                const count = Number(rows[0]?.count ?? 0);
                // `>=` rather than `>`: `count` is post-increment, so the
                // request that takes the bucket TO the limit is the last one
                // allowed... and the next is refused. Using `>` would permit
                // limit+1.
                return count > window.limit ? 'over' : 'under';
            } catch (error) {
                // Everything reaching here is systemic — no contention branch
                // exists for a single upsert. Reported as `unavailable` so the
                // caller's circuit breaker can fail open.
                logger.error({ error, key }, '[rate-limit] postgres error');
                return 'unavailable';
            }
        },
    };
}
