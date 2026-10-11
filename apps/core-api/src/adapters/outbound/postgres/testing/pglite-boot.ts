import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../../../../../migrations/load.js';

/**
 * A fresh PGlite with every shipped migration applied, in order and one file at
 * a time, as the migrator applies them. The source of the per-run template, and
 * the fallback when no template is provided. Kept apart from `pglite.ts`
 * because the global setup runs on vitest's main thread, where `inject` (which
 * `pglite.ts` imports) is not available.
 */
export async function bootMigratedPglite(): Promise<PGlite> {
    const pg = await PGlite.create();
    for (const migration of loadMigrations()) {
        await pg.exec(migration.sql);
    }
    return pg;
}
