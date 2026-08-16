import { logger } from '../../../lib/logger.js';
import type {
    IdempotencyClaim,
    IdempotencyStore,
} from '../../../ports/idempotency-store.js';
import type { SqlClient } from '../../../ports/sql-client.js';

/**
 * Postgres-backed `IdempotencyStore`.
 *
 * `claim` is the interesting one: the Firestore binding runs a transaction with
 * four branches (absent / expired / processing / completed), and all four
 * collapse into one statement here.
 *
 * ## How the single statement covers all four cases
 *
 *   insert ... on conflict (id) do update
 *       set <fresh processing marker>
 *       where idempotency_keys.expires_at < now()
 *   returning status, response, (xmax = 0) as inserted
 *
 *   - **Absent** — the INSERT lands. `xmax = 0` is true for a freshly inserted
 *     row, so `inserted` distinguishes it from an update. → `claimed`
 *   - **Expired** — the conflict fires, the `where` passes, the row is reset to
 *     a new processing marker. The RETURNING clause reports the NEW row, so
 *     `status` is `processing` and `inserted` is false. → `claimed`
 *   - **Live, processing** — conflict fires, `where` fails, DO UPDATE is
 *     skipped. A skipped DO UPDATE returns **no row at all**, which is the one
 *     genuinely non-obvious part of this statement. → look it up. → `in-progress`
 *   - **Live, completed** — same: no row returned, then the lookup finds
 *     `completed`. → `{ replay }`
 *
 * The empty-result case therefore means "a live record already exists", and the
 * follow-up SELECT reads it. Two round trips only on the contended path; the
 * common path (absent) is one.
 *
 * ## Why `xmax = 0` and not something readable
 *
 * There is no portable "did this upsert insert or update" flag. `xmax` is the
 * deleting transaction id, zero on a row this transaction inserted and non-zero
 * on one it updated — the standard idiom. Worth the comment because it is
 * unreadable without one, but the alternative (a second round trip to find out)
 * costs more than the explanation.
 */

const CLAIM = `
    insert into idempotency_keys (id, status, created_at, expires_at)
    values ($1, 'processing', now(), now() + $2::interval)
    on conflict (id) do update
        set status       = 'processing',
            created_at   = now(),
            completed_at = null,
            response     = null,
            expires_at   = excluded.expires_at
        where idempotency_keys.expires_at < now()
    returning status, response, (xmax = 0) as inserted
`;

const READ = `select status, response from idempotency_keys where id = $1`;

const SETTLE = `
    insert into idempotency_keys (id, status, response, created_at, completed_at, expires_at)
    values ($1, 'completed', $2::jsonb, now(), now(), now() + $3::interval)
    on conflict (id) do update
        set status       = 'completed',
            response     = excluded.response,
            completed_at = now(),
            expires_at   = excluded.expires_at
`;

function ms(value: number): string {
    return `${Math.max(0, Math.round(value))} milliseconds`;
}

interface Row {
    status: string;
    response: unknown;
}

export function postgresIdempotencyStore(sql: SqlClient): IdempotencyStore {
    return {
        async claim(id: string, ttlMs: number): Promise<IdempotencyClaim> {
            const claimed = await sql.query<Row>(CLAIM, [id, ms(ttlMs)]);
            // A row back means we own the key — either inserted fresh or
            // reclaimed from expiry. Both are `claimed` per the port contract,
            // which is why `inserted` is not inspected here: it is selected for
            // debuggability, not for control flow.
            if (claimed.length > 0) return 'claimed';

            // No row ⇒ the DO UPDATE was skipped ⇒ a live record exists.
            const existing = await sql.query<Row>(READ, [id]);
            const row = existing[0];
            if (!row) {
                // The row vanished between the two statements — a concurrent
                // sweep is the only plausible cause. Retrying the claim would
                // be correct but adds a loop for an outcome that is safe to
                // treat as in-progress: the caller 409s, the client retries,
                // and the next claim succeeds against an empty slot.
                logger.warn({ id }, '[idempotency] record vanished between claim and read');
                return 'in-progress';
            }
            if (row.status === 'completed') return { replay: row.response };
            return 'in-progress';
        },

        async settle(id: string, response: unknown, ttlMs: number): Promise<void> {
            // `settle` is best-effort by contract — the work already succeeded,
            // so failing the request here would be strictly worse than a
            // possible duplicate execution on retry.
            try {
                await sql.query(SETTLE, [id, JSON.stringify(response ?? null), ms(ttlMs)]);
            } catch (error) {
                logger.error({ error, id }, '[idempotency] failed to record result; replay unavailable');
            }
        },
    };
}
