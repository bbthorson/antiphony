import { Pool } from '@neondatabase/serverless';
import { loadMigrations } from '../migrations/load.js';

/**
 * Apply pending migrations to whatever `DATABASE_URL` points at.
 *
 * ```bash
 * DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api
 * DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --dry-run
 * DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --until 0003
 * DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --baseline
 * ```
 *
 * ## Why this exists now
 *
 * `db/schema.sql` was apply-once DDL, run by hand with `psql -f`, and its own
 * header said a migration tool "is the next thing to fix if the schema changes
 * after first deploy." Nothing had changed it since the cutover, which made this
 * the cheapest possible moment: there is exactly one file to adopt, it is
 * `0001`, and the ledger starts with no history to reconstruct. After the first
 * real change it would have meant reverse-engineering what production had.
 *
 * ## Why this and not a migration tool
 *
 * Ported from the Vox Pop BFF (`apps/vox-pop-api/scripts/migrate.ts`), and the
 * reasoning transfers unchanged: this repo runs migrations rarely and by hand.
 * A tool would bring a config file, a DSL, and a second opinion about what a
 * migration is, in exchange for solving a problem — coordinating many
 * migrations across many developers — that this repo does not have. What it
 * actually needs is: apply files in order, once, and refuse to be confused
 * about which have run.
 *
 * ## What it guarantees
 *
 *  - **Ordering.** Lexicographic by filename; see `migrations/load.ts`.
 *  - **Once.** `schema_migrations` records every applied file.
 *  - **Atomicity per file.** Each migration runs inside its own transaction,
 *    with its `schema_migrations` row inserted in the same transaction, so a
 *    file cannot be half-applied and cannot be recorded without having applied.
 *    Postgres has transactional DDL; this is the payoff. It is also why
 *    migration files must NOT contain their own `begin;`/`commit;` — `0001` had
 *    them as `db/schema.sql` and they were stripped when it moved.
 *  - **Immutability.** Editing a file that has already run is a hard error, not
 *    a no-op. The checksum is what turns "I tweaked 0001 and it didn't take"
 *    from a mystery into a message.
 *
 * It deliberately does NOT support down-migrations. A `DROP TABLE` that runs
 * from a script is a footgun far larger than the convenience it buys.
 *
 * ## Why `Pool` and not the `neon()` HTTP client the adapters use
 *
 * `adapters/outbound/postgres/client.ts` runs `neon()` in HTTP mode, which is
 * right for the Worker: stateless, one round trip per query, no session. It is
 * wrong here for two reasons. HTTP mode has no interactive transaction, so
 * "apply this file and record it atomically" is not expressible; and it sends
 * each statement separately, whereas a migration file is many statements that
 * must go over the simple query protocol in one go. `Pool` opens a real
 * session over WebSocket and does both.
 *
 * No `ws` dependency is needed: `engines.node` is >= 22 here and the driver
 * picks up the **global** `WebSocket`. Adding `ws` would install a Node-only
 * polyfill into a repo whose service target is workerd.
 */

/** `pg` raises this when the connection is fine but the statement is not. */
function describe(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
        const { message, position } = err as { message?: string; position?: string };
        return position ? `${message} (at character ${position})` : String(message);
    }
    return String(err);
}

/**
 * Validate the shape and nothing else — the host, database name and credentials
 * are Neon's to define, and a wrong-but-well-formed value has to fail at
 * connect time regardless. The point is to convert the two mistakes that
 * produce genuinely baffling errors into a clear one: a value that is empty
 * because the secret did not mount, and a bare hostname or a `psql` invocation
 * someone pasted out of the Neon console.
 */
function connectionString(): string | null {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return null;
    if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) return null;
    return url;
}

async function main(): Promise<void> {
    const dryRun = process.argv.includes('--dry-run');
    const baseline = process.argv.includes('--baseline');

    // `--until 0003` — apply through the last file whose name starts with the
    // given prefix, then stop. Matched on the filename prefix rather than an
    // exact name so the caller types the number, not the whole slug. The case
    // that needs it is a migration whose precondition is a BACKFILL that runs
    // between two files.
    const untilAt = process.argv.indexOf('--until');
    const until = untilAt === -1 ? null : process.argv[untilAt + 1];
    if (untilAt !== -1 && !until) {
        console.error('--until needs a filename prefix, e.g. `--until 0003`.');
        process.exitCode = 1;
        return;
    }
    if (baseline && (dryRun || until)) {
        console.error('--baseline cannot be combined with --dry-run or --until.');
        process.exitCode = 1;
        return;
    }

    const url = connectionString();
    if (!url) {
        // Checked up front rather than letting the pool throw mid-loop, so the
        // common mistake (forgetting to export the secret) reads as
        // configuration rather than as a failed migration.
        console.error(
            'DATABASE_URL is not set or is not a postgres:// URI.\n' +
                'Export it against the Neon branch you mean to migrate.',
        );
        process.exitCode = 1;
        return;
    }

    const migrations = loadMigrations();
    if (migrations.length === 0) {
        console.log('No migration files found.');
        return;
    }

    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
        // The ledger bootstraps itself. It is not one of the numbered
        // migrations because it is what makes numbered migrations possible.
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   text PRIMARY KEY,
                checksum   text        NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        `);

        const { rows } = await client.query<{ filename: string; checksum: string }>(
            'SELECT filename, checksum FROM schema_migrations',
        );
        const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

        let pending = [];
        for (const migration of migrations) {
            const previous = applied.get(migration.filename);
            if (previous === undefined) {
                pending.push(migration);
            } else if (previous !== migration.checksum) {
                // Loud, and before anything is applied — a drifted earlier file
                // usually means the database is not the shape the later files
                // assume, so applying them on top would compound it.
                throw new Error(
                    `${migration.filename} has changed since it was applied ` +
                        `(recorded ${previous.slice(0, 12)}…, file is ${migration.checksum.slice(0, 12)}…). ` +
                        'Migrations are immutable once applied — add a new file instead.',
                );
            }
        }

        if (pending.length === 0) {
            console.log(`Up to date — ${applied.size} migration(s) already applied.`);
            return;
        }

        // ── --baseline ────────────────────────────────────────────────────────
        //
        // Record every pending migration as applied WITHOUT running it.
        //
        // This exists because of how the ledger was adopted. `0001` describes
        // the schema production has been running since the cutover, applied by
        // hand with `psql -f db/schema.sql` before any of this existed. A plain
        // `migrate` against that database would try to create tables that are
        // already there and fail on the first one — so the ledger has to be
        // told what it missed, once.
        //
        // It is deliberately all-or-nothing over the pending set and in ONE
        // transaction: baselining half a chain would leave a database claiming
        // a state it does not have, which is strictly worse than the problem
        // this solves.
        //
        // ⚠️ This is the one operation here that can lie. Everything else
        // proves what it did by doing it; this asserts something about the
        // database that the operator is vouching for. Use it only for
        // migrations the database demonstrably already has.
        if (baseline) {
            console.log(`Baselining ${pending.length} migration(s) as already applied:`);
            for (const m of pending) console.log(`  ${m.filename}`);
            await client.query('BEGIN');
            try {
                for (const m of pending) {
                    await client.query(
                        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
                        [m.filename, m.checksum],
                    );
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`baseline failed: ${describe(err)}`, { cause: err });
            }
            console.log(
                'Recorded. NOTHING was executed — if the database did not already have this ' +
                    'schema, it still does not.',
            );
            return;
        }

        if (until) {
            // The drift check above deliberately ran over *every* migration, not
            // just the ones about to be applied: a drifted earlier file usually
            // means the database is not the shape the later ones assume, and
            // that is worth hearing whether or not this run reaches them.
            const cut = pending.findIndex((m) => m.filename.startsWith(until));
            if (cut === -1) {
                const held = pending.map((m) => m.filename).join(', ') || 'none';
                console.error(`No pending migration starts with '${until}'. Pending: ${held}.`);
                process.exitCode = 1;
                return;
            }
            const held = pending.slice(cut + 1);
            pending = pending.slice(0, cut + 1);
            if (held.length > 0) {
                console.log(`Stopping after ${until}; holding back ${held.length}:`);
                for (const m of held) console.log(`  ${m.filename}`);
            }
        }

        if (dryRun) {
            console.log(`${pending.length} pending migration(s):`);
            for (const m of pending) console.log(`  ${m.filename}`);
            return;
        }

        for (const migration of pending) {
            process.stdout.write(`applying ${migration.filename} … `);
            await client.query('BEGIN');
            try {
                // No parameters, so this goes over the simple query protocol
                // and a file may contain many statements — which is what lets a
                // migration be readable SQL rather than a JS array of strings.
                await client.query(migration.sql);
                await client.query(
                    'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
                    [migration.filename, migration.checksum],
                );
                await client.query('COMMIT');
                console.log('ok');
            } catch (err) {
                await client.query('ROLLBACK');
                console.log('FAILED');
                throw new Error(`${migration.filename}: ${describe(err)}`, { cause: err });
            }
        }

        console.log(`Applied ${pending.length} migration(s).`);
    } finally {
        client.release();
        // Without this the pool holds the event loop open and the script hangs
        // after printing its success line.
        await pool.end();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
