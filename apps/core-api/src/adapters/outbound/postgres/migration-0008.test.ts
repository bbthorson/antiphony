import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../../../../migrations/load.js';

/**
 * Migration 0008 over rows registered before it: every Phase A row was fetched
 * from a public repo, so it stays a plain, fetched row, and the sweep still
 * reaches it through the index that replaces 0006's.
 */
describe('migration 0008: remote posts in spaces', () => {
    it('keeps existing rows as fetched repo records, and swaps the sweep index', async () => {
        const pg = await PGlite.create();
        const all = loadMigrations();
        const at = all.findIndex((m) => m.filename.startsWith('0008_'));
        for (const m of all.slice(0, at)) await pg.exec(m.sql);

        await pg.query(
            `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record, blob_cid, mime_type, size, created_at)
             values ('vox-pop', 'at://did:plc:a/dev.antiphony.audio.post/3k', 'c', 'did:plc:a', 'dev.antiphony.audio.post', '3k',
                     '{}', 'b', 'audio/mp4', 1, now())`,
        );
        await pg.exec(all[at].sql);

        const { rows } = await pg.query('select space, verified from remote_posts');
        expect(rows).toEqual([{ space: null, verified: 'fetched' }]);

        const { rows: indexes } = await pg.query<{ indexname: string }>(
            `select indexname from pg_indexes where tablename = 'remote_posts' and indexname like 'remote_posts_%_idx'`,
        );
        const names = indexes.map((i) => i.indexname);
        expect(names).toContain('remote_posts_sweep_idx');
        expect(names).not.toContain('remote_posts_checked_idx');
        await pg.close();
    });
});
