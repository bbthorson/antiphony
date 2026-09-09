import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads the `.sql` files sitting beside this one.
 *
 * Two consumers, and having exactly two is the point:
 *
 *  - `scripts/migrate.ts`, which applies them to Neon.
 *  - `src/adapters/outbound/postgres/testing/pglite.ts`, which applies the same
 *    files to an in-process Postgres 18 for the binding suites.
 *
 * The tests therefore run against **the schema that ships**, not against a
 * hand-maintained fixture that agrees with it until someone edits one and not
 * the other. That property is not new — `pglite.ts` previously read
 * `db/schema.sql` directly for exactly this reason — but it is now the chain
 * rather than a single file, so a migration that only production has ever seen
 * cannot exist.
 *
 * Not part of the deployed Worker bundle: `wrangler` bundles from `src/`, and
 * nothing under `src/` imports this. Migrations are an operator action, never
 * something the service does to itself on boot — a Worker that migrated at
 * startup would migrate once per cold start, which is to say concurrently and
 * unboundedly.
 */

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

export interface Migration {
    /** `0001_initial_schema.sql` — the primary key in `schema_migrations`. */
    filename: string;
    sql: string;
    /** sha256 of `sql`, so an edit to an already-applied file is caught. */
    checksum: string;
}

/**
 * Every migration, in lexicographic filename order.
 *
 * Ordering is by zero-padded numeric prefix, which is why the prefix is `0001`
 * and not `1`: `10` sorts before `2` otherwise, and the failure would be a
 * migration silently applied out of order rather than an error.
 */
export function loadMigrations(): Migration[] {
    return readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((filename) => {
            const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
            return {
                filename,
                sql,
                checksum: createHash('sha256').update(sql).digest('hex'),
            };
        });
}
