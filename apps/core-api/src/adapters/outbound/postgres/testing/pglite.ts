import { readFileSync } from 'node:fs';
import { inject } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { bootMigratedPglite } from './pglite-boot.js';
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
 * ## It applies the SHIPPED MIGRATIONS, deliberately
 *
 * `../../../../../migrations/*.sql` is the same chain you apply to Neon, read
 * through the same `loadMigrations()` the migrator uses. Copying it into a
 * fixture would let the two drift, and the drift would be silent in exactly the
 * direction that matters — tests passing against a schema production does not
 * have. Reading the real files means a column renamed in a migration breaks the
 * binding suite immediately.
 *
 * This read `db/schema.sql` until that file became `0001_initial_schema.sql`.
 * The property is unchanged and the guarantee is now slightly stronger: a
 * migration nobody added to the chain cannot be exercised here, so a schema
 * change that exists only in someone's psql history cannot pass tests.
 *
 * Applied in ORDER and one file at a time, because that is how the migrator
 * applies them — a later migration that depends on an earlier one must fail
 * here for the same reason it would fail there.
 *
 * It also means the schema's own claims get exercised. The `stored` keyword on
 * every generated column is load-bearing under PG18 (virtual is the default and
 * virtual columns cannot be indexed); if someone drops it, `CREATE INDEX` fails
 * during setup here and the suite says so.
 */

export interface TestDatabase extends SqlClient {
    /** Close the instance. Call in `afterEach`/`afterAll`. */
    close(): Promise<void>;
    /** Empty every table without re-applying DDL — cheaper than a fresh instance per test. */
    truncate(): Promise<void>;
}

declare module 'vitest' {
    interface ProvidedContext {
        /** A dump of a migrated database, written once per run by `pglite-global-setup.ts`. */
        pgliteTemplatePath: string;
    }
}

/**
 * Boot a fresh in-memory Postgres with the shipped schema applied.
 *
 * Each call is an isolated database, so suites never share state. It loads the
 * migrated template the global setup dumped (~0.7s) rather than running initdb
 * and the migrations again (~3–4s), falling back to doing exactly that when
 * the template is not provided. Still worth paying per FILE but not per test —
 * use `truncate()` between cases.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
    const templatePath = inject('pgliteTemplatePath');
    const pg = templatePath
        ? await PGlite.create({ loadDataDir: new Blob([readFileSync(templatePath)]) })
        : await bootMigratedPglite();

    // Every table the migrations created, read back rather than listed by hand:
    // a hand-kept list silently stops emptying the table the next migration
    // adds, and its rows then leak from one test into the next.
    const tables = (
        await pg.query<{ tablename: string }>(
            "select tablename from pg_tables where schemaname = 'public' order by tablename",
        )
    ).rows.map((r) => `"${r.tablename}"`);

    return {
        async query<T = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = [],
        ): Promise<T[]> {
            const res = await pg.query<T>(text, params as unknown[]);
            return res.rows;
        },
        async truncate(): Promise<void> {
            await pg.exec(`truncate ${tables.join(', ')}`);
        },
        async close(): Promise<void> {
            await pg.close();
        },
    };
}
