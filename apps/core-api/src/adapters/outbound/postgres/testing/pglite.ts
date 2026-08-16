import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SqlClient } from '../../../../ports/sql-client.js';

/**
 * An in-process Postgres for the binding suites.
 *
 * PGlite 0.5 is **PostgreSQL 18** compiled to WASM — the same major as the Neon
 * target — with no native install step and no service to stand up. That makes
 * these real integration tests rather than mock-verification: the bindings run
 * their actual SQL against an actual planner, and a statement that does not
 * parse, an `ON CONFLICT` naming a constraint that does not exist, or a type
 * that will not cast fails here instead of in production.
 *
 * ## It applies the SHIPPED schema, deliberately
 *
 * `db/schema.sql` is the same file you apply to Neon. Copying it into a fixture
 * would let the two drift, and the drift would be silent in exactly the
 * direction that matters — tests passing against a schema production does not
 * have. Reading the real file means a column renamed in the schema breaks the
 * binding suite immediately.
 *
 * It also means the schema's own claims get exercised. The `stored` keyword on
 * every generated column is load-bearing under PG18 (virtual is the default and
 * virtual columns cannot be indexed); if someone drops it, `CREATE INDEX` fails
 * during setup here and the suite says so.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../../../../../db/schema.sql');

export interface TestDatabase extends SqlClient {
    /** Close the instance. Call in `afterEach`/`afterAll`. */
    close(): Promise<void>;
    /** Empty every table without re-applying DDL — cheaper than a fresh instance per test. */
    truncate(): Promise<void>;
}

/**
 * Boot a fresh in-memory Postgres with the shipped schema applied.
 *
 * Each call is an isolated database, so suites never share state. Booting costs
 * ~100–200ms, which is worth paying per FILE but not per test — use
 * `truncate()` between cases.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
    const pg = await PGlite.create();
    await pg.exec(readFileSync(SCHEMA_PATH, 'utf8'));

    return {
        async query<T = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = [],
        ): Promise<T[]> {
            const res = await pg.query<T>(text, params as unknown[]);
            return res.rows;
        },
        async truncate(): Promise<void> {
            await pg.exec('truncate posts, audio_transcripts, idempotency_keys, rate_limits');
        },
        async close(): Promise<void> {
            await pg.close();
        },
    };
}
