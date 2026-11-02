import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../../../../migrations/load.js';

/**
 * Migration 0009 over rows written before it: it only swaps indexes, so every
 * row reads back as it was, and the planner has the two the sweep and a
 * recheck need.
 */
describe('migration 0009: rechecking space records', () => {
    it('keeps every row, and swaps the sweep index for repo-record and per-space ones', async () => {
        const pg = await PGlite.create();
        const all = loadMigrations();
        const at = all.findIndex((m) => m.filename.startsWith('0009_'));
        for (const m of all.slice(0, at)) await pg.exec(m.sql);

        const insert = (uri: string, space: unknown, verified: string) =>
            pg.query(
                `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record, blob_cid, mime_type, size,
                                           created_at, space, verified)
                 values ('vox-pop', $1, 'c', 'did:plc:a', 'dev.antiphony.audio.post', '3k', '{}', 'b', 'audio/mp4', 1, now(), $2::jsonb, $3)`,
                [uri, space === null ? null : JSON.stringify(space), verified],
            );
        await insert('at://did:plc:a/dev.antiphony.audio.post/3k', null, 'fetched');
        await insert('at://did:plc:g/space/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k', { authority: 'did:plc:g', type: 'a.b.c', skey: 'k' }, 'pushed');
        await pg.exec(all[at].sql);

        const { rows } = await pg.query<{ uri: string; verified: string }>('select uri, verified from remote_posts order by uri');
        expect(rows.map((r) => r.verified)).toEqual(['fetched', 'pushed']);

        const { rows: indexes } = await pg.query<{ indexname: string }>(
            `select indexname from pg_indexes where tablename = 'remote_posts'`,
        );
        const names = indexes.map((i) => i.indexname);
        expect(names).toEqual(expect.arrayContaining(['remote_posts_repo_sweep_idx', 'remote_posts_space_checked_idx']));
        expect(names).not.toContain('remote_posts_sweep_idx');
        await pg.close();
    });
});
