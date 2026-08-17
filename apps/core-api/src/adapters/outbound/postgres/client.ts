import { neon } from '@neondatabase/serverless';
import type { SqlClient } from '../../../ports/sql-client.js';

/**
 * Production `SqlClient`, backed by `@neondatabase/serverless` over HTTP.
 *
 * ## Why the HTTP driver
 *
 * Every statement the bindings issue is a single parameterised query — that is
 * the whole design of db/schema.sql, where each Firestore transaction collapsed
 * into one upsert or one conditional `UPDATE … RETURNING`. The HTTP driver's
 * one real limitation is that it cannot hold an interactive transaction open,
 * and nothing here needs one. (It stopped being able to bind at all once the
 * `/system/atproto-*` deletion took `users`/`handles` with it — the handle swap
 * was the last operation that genuinely wanted one.)
 *
 * It is also the driver that works everywhere this code runs during the
 * migration: a Node script, Cloud Run, and a Worker all have `fetch`.
 *
 * ## Why NOT Hyperdrive — and what it would cost to have it
 *
 * Geography argues for Hyperdrive: Neon is `us-east-1` and Workers execute near
 * the USER, so a request served far from Virginia pays a full round trip per
 * query. Hyperdrive terminates in Cloudflare's network and keeps connections
 * warm.
 *
 * This driver cannot use it. `neon()` in HTTP mode derives an HTTPS endpoint
 * from the connection string's HOSTNAME and POSTs to `https://{host}/sql`; a
 * Hyperdrive string names Cloudflare, which serves no such endpoint. So the
 * deployed Worker reads `DATABASE_URL` — Neon's pooled host, a real credential
 * held as a Worker secret — and `wrangler.jsonc` binds no Hyperdrive at all.
 * Smart Placement carries the geography argument on its own in the meantime, by
 * moving execution next to the backend rather than the connection next to the
 * user.
 *
 * Adopting Hyperdrive therefore means REPLACING this file with a wire-protocol
 * driver (`postgres.js` or `pg`) over Hyperdrive's TCP socket, against Neon's
 * DIRECT host — Hyperdrive pools itself, so stacking it on PgBouncer is
 * discouraged. `SqlClient` is one method, so that swap stays behind the port.
 * See specs/cloudflare-migration.md § Verified deploy blockers, option B.
 */
export function neonSqlClient(connectionString: string): SqlClient {
    const sql = neon(connectionString);

    return {
        async query<T = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = [],
        ): Promise<T[]> {
            // `neon()`'s function form takes (text, params) and resolves to the
            // row array directly — no `.rows` unwrap, unlike node-postgres.
            return (await sql.query(text, params as unknown[])) as T[];
        },
    };
}

/**
 * Read the connection string from the environment, or explain what is missing.
 *
 * Returns the reason rather than throwing so a caller can distinguish "not
 * configured" from "configured wrong" — the same pattern `cloudTasksConfig()`
 * uses, and for the same reason: those look identical at the call site and are
 * opposite problems.
 */
export function neonConnectionString(): { url: string } | { missing: string } {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return { missing: 'DATABASE_URL' };
    return { url };
}
