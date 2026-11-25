import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../../../../migrations/load.js';

/**
 * Migration 0012 over rows written before it: alpha-era space URIs
 * (`at://{did}/space/…`) read back in the `at:space/` form, wherever they're
 * stored or indexed, and public URIs are untouched. Record values keep what
 * was written, since their CIDs are computed over them.
 */
const OLD_PARENT = 'at://did:plc:g/space/a.b.c/k/did:plc:g/dev.antiphony.audio.post/3parent';
const NEW_PARENT = 'at:space/did:plc:g/a.b.c/k/did:plc:g/dev.antiphony.audio.post/3parent';
const OLD_REMOTE = 'at://did:plc:g/space/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k';
const NEW_REMOTE = 'at:space/did:plc:g/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k';
const PUBLIC = 'at://did:plc:a/dev.antiphony.audio.post/3p';

describe('migration 0012: the at:space/ URI form', () => {
    it('rewrites stored space URIs, normalizes generated ones, and leaves public URIs and record values alone', async () => {
        const pg = await PGlite.create();
        const all = loadMigrations();
        const at = all.findIndex((m) => m.filename.startsWith('0012_'));
        for (const m of all.slice(0, at)) await pg.exec(m.sql);

        const reply = (id: string, parentUri: string) =>
            pg.query(`insert into posts (id, origin_app_id, record, created_at) values ($1, 'vox-pop', $2::jsonb, now())`, [
                id,
                JSON.stringify({
                    cid: `c-${id}`,
                    authorId: 'u1',
                    kind: 'reply',
                    rootAuthorId: 'u0',
                    reply: { parent: { uri: parentUri, cid: 'cp' }, root: { uri: parentUri, cid: 'cp' } },
                }),
            ]);
        await reply('r-space', OLD_PARENT);
        await reply('r-public', PUBLIC);

        await pg.query(
            `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record, blob_cid, mime_type, size,
                                       created_at, space, verified)
             values ('vox-pop', $1, 'c', 'did:plc:a', 'dev.antiphony.audio.post', '3k', $2::jsonb, 'b', 'audio/mp4', 1, now(),
                     '{"authority":"did:plc:g","type":"a.b.c","skey":"k"}', 'pushed')`,
            [OLD_REMOTE, JSON.stringify({ reply: { parent: { uri: OLD_PARENT }, root: { uri: OLD_PARENT } } })],
        );
        await pg.query(
            `insert into audio_transcripts (id, origin_app_id, record, created_at)
             values ('t1', 'vox-pop', $1::jsonb, '2026-11-01T00:00:00Z')`,
            [JSON.stringify({ subject: { uri: OLD_PARENT, cid: 'cp' }, createdAt: '2026-11-01T00:00:00Z' })],
        );
        await pg.query(`insert into deleted_posts (origin_app_id, post_id, uri, kind) values ('vox-pop', '3parent', $1, 'reply')`, [
            OLD_PARENT,
        ]);
        await pg.query(`insert into deleted_remote_posts (origin_app_id, uri, reason) values ('vox-pop', $1, 'gone')`, [OLD_REMOTE]);

        await pg.exec(all[at].sql);
        // Safe to run again: it only ever matches the old form.
        await pg.exec(all[at].sql);

        const posts = await pg.query<{ id: string; reply_parent_uri: string; reply_root_uri: string; stored: string }>(
            `select id, reply_parent_uri, reply_root_uri, record -> 'reply' -> 'parent' ->> 'uri' as stored from posts order by id`,
        );
        expect(posts.rows).toEqual([
            { id: 'r-public', reply_parent_uri: PUBLIC, reply_root_uri: PUBLIC, stored: PUBLIC },
            { id: 'r-space', reply_parent_uri: NEW_PARENT, reply_root_uri: NEW_PARENT, stored: OLD_PARENT },
        ]);

        const remote = await pg.query<{ uri: string; reply_parent_uri: string; reply_root_uri: string }>(
            'select uri, reply_parent_uri, reply_root_uri from remote_posts',
        );
        expect(remote.rows).toEqual([{ uri: NEW_REMOTE, reply_parent_uri: NEW_PARENT, reply_root_uri: NEW_PARENT }]);

        const transcripts = await pg.query<{ subject_uri: string }>('select subject_uri from audio_transcripts');
        expect(transcripts.rows).toEqual([{ subject_uri: NEW_PARENT }]);

        expect((await pg.query<{ uri: string }>('select uri from deleted_posts')).rows).toEqual([{ uri: NEW_PARENT }]);
        expect((await pg.query<{ uri: string }>('select uri from deleted_remote_posts')).rows).toEqual([{ uri: NEW_REMOTE }]);

        // The shape check admits the new form, and still refuses anything else.
        await expect(
            pg.query(
                `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record, blob_cid, mime_type, size, created_at)
                 values ('vox-pop', 'https://x', 'c', 'did:plc:a', 'dev.antiphony.audio.post', '3x', '{}', 'b', 'audio/mp4', 1, now())`,
            ),
        ).rejects.toThrow(/remote_posts_uri_shape/);
        await pg.close();
    }, 15_000);
});
