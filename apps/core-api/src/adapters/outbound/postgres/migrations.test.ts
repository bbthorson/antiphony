import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../../../../migrations/load.js';

/**
 * Guards on the migration CHAIN itself, as opposed to on what it produces.
 *
 * The binding suites in this directory already prove the schema works — they
 * apply the chain to an in-process Postgres 18 and run the real adapters
 * against it. What they cannot catch is a chain that is malformed in a way
 * Postgres accepts: a file that manages its own transaction, two files that
 * claim the same number, or a prefix that sorts wrongly. Each of those produces
 * a migration applied out of order or a transaction that closed early, and both
 * fail silently in the direction that matters.
 */
describe('the migration chain', () => {
    const migrations = loadMigrations();

    it('is not empty', () => {
        // A loader that silently returns nothing would make every other
        // assertion here vacuous, and would make `migrate` report "up to date"
        // against an empty database.
        expect(migrations.length).toBeGreaterThan(0);
    });

    it('names every file with a four-digit prefix', () => {
        // Ordering is lexicographic, so the padding is what makes it numeric.
        // Without it `10_x.sql` sorts before `2_x.sql` and the failure is a
        // migration applied out of order rather than an error.
        for (const { filename } of migrations) {
            expect(filename, `${filename} must start with four digits`).toMatch(
                /^\d{4}_[a-z0-9_]+\.sql$/,
            );
        }
    });

    it('gives every migration a distinct number', () => {
        // Two files sharing a prefix makes `--until 0004` ambiguous and makes
        // the intended order unknowable from the names.
        const numbers = migrations.map((m) => m.filename.slice(0, 4));
        expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('is returned in ascending filename order', () => {
        const sorted = [...migrations].map((m) => m.filename).sort();
        expect(migrations.map((m) => m.filename)).toEqual(sorted);
    });

    it('leaves transaction control to the migrator', () => {
        // THE IMPORTANT ONE. `scripts/migrate.ts` wraps each file in its own
        // transaction and inserts the ledger row inside it, which is what makes
        // "applied and recorded, or neither" true. A file containing its own
        // `commit;` closes that transaction early: the rest of the file then
        // runs unprotected, and the ledger insert lands in a different
        // transaction from the DDL it is recording.
        //
        // `0001` had exactly this problem as `db/schema.sql`, where a single
        // `begin`/`commit` pair was the right design for `psql -f`. They were
        // stripped when it moved. This stops them coming back, in that file or
        // any other.
        for (const { filename, sql } of migrations) {
            const statements = sql
                .split('\n')
                .map((line) => line.trim().toLowerCase())
                // Strip comments, so prose ABOUT transactions is allowed.
                .filter((line) => !line.startsWith('--'));

            for (const keyword of ['begin;', 'commit;', 'rollback;', 'begin transaction;']) {
                expect(
                    statements.some((line) => line === keyword),
                    `${filename} contains a bare \`${keyword}\` — the migrator owns the transaction`,
                ).toBe(false);
            }
        }
    });

    it('checksums content, so an applied file cannot be edited unnoticed', () => {
        // The checksum is the mechanism behind the immutability error. Assert
        // it is content-derived rather than, say, filename-derived — a
        // filename-derived checksum would make the immutability check useless
        // while still looking like it worked.
        for (const { checksum } of migrations) {
            expect(checksum).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(new Set(migrations.map((m) => m.checksum)).size).toBe(migrations.length);

        // Stable across calls, or every run would report every file as drifted.
        expect(loadMigrations().map((m) => m.checksum)).toEqual(
            migrations.map((m) => m.checksum),
        );
    });
});
