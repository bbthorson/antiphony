import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../../../../migrations/load.js';

/**
 * Migration 0006's transcript backfill, run against data written before it:
 * the template database every other suite uses is already migrated, so this
 * one stops at 0005, writes the old shape, then applies 0006.
 */
describe('migration 0006: transcripts get a tenant', () => {
    async function databaseAt0005(): Promise<{ pg: PGlite; apply0006: () => Promise<void> }> {
        const pg = await PGlite.create();
        const all = loadMigrations();
        const at = all.findIndex((m) => m.filename.startsWith('0006_'));
        for (const m of all.slice(0, at)) await pg.exec(m.sql);
        return { pg, apply0006: async () => void (await pg.exec(all[at].sql)) };
    }

    const createdAt = '2026-10-20T00:00:00.000Z';
    const post = (id: string) => ({
        id,
        cid: 'bafyreipost',
        kind: 'prompt',
        authorId: 'a',
        text: '',
        createdAt,
    });
    const transcript = (id: string, uri: string) => ({
        id,
        subject: { uri, cid: 'bafyreipost' },
        transcript: { segments: [] },
        createdAt,
    });

    it("backfills each transcript's tenant from its post, drops orphans, and keys by (tenant, subject)", async () => {
        const { pg, apply0006 } = await databaseAt0005();
        await pg.query(`insert into posts (id, origin_app_id, record, created_at) values ($1, 'vox-pop', $2::jsonb, $3)`, [
            '3kpostaaaaaaa',
            JSON.stringify(post('3kpostaaaaaaa')),
            createdAt,
        ]);
        await pg.query(`insert into audio_transcripts (id, record, created_at) values ($1, $2::jsonb, $3)`, [
            '3ktranscript1',
            JSON.stringify(transcript('3ktranscript1', 'at://did:web:voxpop.example/dev.antiphony.audio.post/3kpostaaaaaaa')),
            createdAt,
        ]);
        await pg.query(`insert into audio_transcripts (id, record, created_at) values ($1, $2::jsonb, $3)`, [
            '3ktranscript2',
            JSON.stringify(transcript('3ktranscript2', 'at://did:web:voxpop.example/dev.antiphony.audio.post/3kgoneeeeeeee')),
            createdAt,
        ]);

        await apply0006();

        const rows = (await pg.query<{ id: string; origin_app_id: string }>('select id, origin_app_id from audio_transcripts'))
            .rows;
        expect(rows).toEqual([{ id: '3ktranscript1', origin_app_id: 'vox-pop' }]);
        await expect(
            pg.query(`insert into audio_transcripts (id, record, created_at) values ('3kx', $1::jsonb, $2)`, [
                JSON.stringify(transcript('3kx', 'at://x/y/z')),
                createdAt,
            ]),
        ).rejects.toThrow(/origin_app_id/);
        await pg.close();
    });
});
