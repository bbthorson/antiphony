import type { SqlClient } from '../../../ports/sql-client.js';
import type { Logger } from '@antiphony/core/ports/logger';

/**
 * Drive `antiphony_sweep_expired()` — the TTL reclamation that replaces
 * Firestore's native TTL on `idempotency_keys` and `rate_limits`.
 *
 * ## Why the query is one statement with no arguments
 *
 * All of the policy — which tables, which predicate, how many rows per call —
 * is in the function, in `db/schema.sql`, versioned alongside the tables it
 * sweeps. That is deliberate and `schema.sql` says so at length: the caller is
 * `select * from antiphony_sweep_expired();`, so an adapter cannot drift from
 * the schema, and an operator can run the identical thing by hand from psql.
 * Adding a batch-size argument here would put half the policy in TypeScript.
 *
 * ## Why this cannot fail the cron
 *
 * The sweep is **pure space reclamation** — both upserts already treat an
 * expired row as absent, so deleting one is behaviourally identical to leaving
 * it. It may run late, partially, or not at all without anything observable
 * changing except disk. So a failure is logged and swallowed: there is no
 * caller to propagate to, and a throwing `scheduled` handler would turn a
 * harmless miss into a Cloudflare-side error rate on a service that is fine.
 *
 * It is worth noting what this closes. Until the Worker's cron existed, this
 * function shipped with the schema and **nothing called it** — harmless at beta
 * volume, and the reason no interim Cloud Scheduler job was built, but a thing
 * that silently did not happen. See specs/cloudflare-migration.md § Replacing
 * Firestore's native TTL.
 */

/** One row per table the function touched. */
interface SweepRow {
    swept_table: string;
    deleted: number | string;
}

export async function sweepExpired(sql: SqlClient, logger: Logger): Promise<void> {
    try {
        const rows = await sql.query<SweepRow>('select * from antiphony_sweep_expired()');
        // `deleted` is `bigint`, which the driver may hand back as a string —
        // Number() rather than a cast so the log line carries a number either
        // way, and a genuinely huge count is a reporting curiosity rather than
        // a crash.
        const swept = Object.fromEntries(rows.map((r) => [r.swept_table, Number(r.deleted)]));
        const total = Object.values(swept).reduce((sum, n) => sum + n, 0);
        // At `info` even when nothing was deleted. A zero-row sweep is the
        // evidence that the cron is wired and running, which is precisely what
        // was missing before — and a sweep that quietly stops is otherwise
        // indistinguishable from one that has nothing to do.
        logger.info({ swept, total }, '[sweep] expired rows reclaimed');
    } catch (err) {
        logger.error({ err }, '[sweep] failed — space reclamation deferred to the next run');
    }
}
