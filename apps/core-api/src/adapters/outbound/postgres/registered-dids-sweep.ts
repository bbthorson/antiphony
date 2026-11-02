import type { SqlClient } from '../../../ports/sql-client.js';
import type { Logger } from '@antiphony/core/ports/logger';
import { revalidateRegisteredDids, type EnsurePinOptions } from '../../../lib/app-did.js';

/**
 * How many registered DIDs one cron run revalidates. Each is a DID-document
 * fetch, run one after another inside the hourly invocation, so the sweep is
 * bounded. Past this many, a random sample is checked each hour, so every DID
 * is reached over a few runs; a write under any DID still re-proves custody on
 * its own (`ensureDidCustody`), so a DID missed this hour is never unguarded.
 */
export const REGISTERED_DID_SWEEP_LIMIT = 500;

/**
 * The hourly custody sweep over `tenant_dids` (migration 0004): load the
 * registered DIDs and revalidate each, reporting any that no longer name this
 * deployment (specs/did-plc-and-multi-did-tenancy.md §2, "Cron").
 *
 * Swallows its own failures, for the reason `sweepExpired` does: it only
 * reports, and a throwing `scheduled` handler would cut short the maintenance
 * that runs after it.
 */
export async function sweepRegisteredDids(sql: SqlClient, logger: Logger, opts: EnsurePinOptions): Promise<void> {
    try {
        const rows = await sql.query<{ did: string; origin_app_id: string }>(
            'select did, origin_app_id from tenant_dids order by random() limit $1',
            [REGISTERED_DID_SWEEP_LIMIT],
        );
        if (rows.length === 0) return;
        const failures = await revalidateRegisteredDids(
            rows.map((r) => ({ did: r.did, originAppId: r.origin_app_id })),
            opts,
        );
        if (failures.length > 0) {
            logger.error(
                { drift: failures },
                '[app-did] registered DID drift detected — a DID no longer proves custody; writes under it will fail',
            );
        }
        logger.info(
            { checked: rows.length, failed: failures.length, sampled: rows.length === REGISTERED_DID_SWEEP_LIMIT },
            '[app-did] registered DIDs revalidated',
        );
    } catch (err) {
        logger.error({ err }, '[app-did] registered DID sweep failed; writes still re-prove custody per DID');
    }
}
