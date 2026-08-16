import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { cidForRecord } from '../../../lib/cid.js';
import type { AudioPostRecord } from 'shared/types/audio';

// `getAppDid` reads the boot-validated pin snapshot, and `StorageService` is the
// blob store — neither is under test here, and both would otherwise drag the
// Firebase bootstrap into a Postgres suite.
vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:example.com',
}));
vi.mock('../firebase/core-services-firebase.js', () => ({
    StorageService: { getSignedUrl: async () => 'https://signed.example/audio' },
}));

/**
 * Postgres `AudioPostDependencies` against real Postgres 18 (PGlite).
 *
 * Weighted toward the three things that changed in the port — keyset
 * pagination, the un-chunked transcript lookup, and the record/processing
 * column split — plus the CID round-trip the schema's § Open calls for.
 */

function post(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return {
        id: 'aaaaaaaaaaaaa',
        cid: 'bafyreiaaa',
        originAppId: 'vox-pop',
        authorId: 'user-1',
        kind: 'prompt',
        text: 'hello',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...over,
    } as AudioPostRecord;
}

function reply(id: string, over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return post({
        id,
        kind: 'reply',
        rootAuthorId: 'user-root',
        reply: {
            root: { uri: 'at://did:web:example.com/c/root', cid: 'bafyreiroot' },
            parent: { uri: 'at://did:web:example.com/c/parent', cid: 'bafyreiparent' },
        },
        ...over,
    });
}

describe('postgresAudioPostDependencies', () => {
    let db: TestDatabase;
    let deps: ReturnType<typeof postgresAudioPostDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        deps = postgresAudioPostDependencies(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    describe('savePost / getPostById', () => {
        it('round-trips a plain post', async () => {
            const p = post();
            await deps.savePost(p);
            await expect(deps.getPostById('vox-pop', p.id)).resolves.toEqual(p);
        });

        it('hides a post belonging to another tenant', async () => {
            await deps.savePost(post());
            await expect(deps.getPostById('other-app', 'aaaaaaaaaaaaa')).resolves.toBeNull();
        });

        it('round-trips processing state across the column split', async () => {
            // The split is the part most likely to break silently: a record
            // reassembled without its `processing` key parses fine and simply
            // looks like a post that never requested processing.
            const p = post({
                processing: {
                    transcribe: 'ready',
                    waveform: 'pending',
                    reprocess: true,
                    processedBlobCid: 'bafkreiprocessed',
                    processedDurationMs: 4200,
                    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
                },
            });
            await deps.savePost(p);
            const read = await deps.getPostById('vox-pop', p.id);
            expect(read?.processing).toEqual(p.processing);
        });

        it('stores the lease in its own column, not in the processing jsonb', async () => {
            const leaseUntil = new Date('2026-08-02T01:00:00.000Z');
            await deps.savePost(
                post({
                    processing: { transcribe: 'pending', updatedAt: new Date(), leaseUntil },
                }),
            );
            const [row] = await db.query<{ processing: Record<string, unknown>; lease_until: Date }>(
                'select processing, lease_until from posts',
            );
            expect(row.processing).not.toHaveProperty('leaseUntil');
            expect(new Date(row.lease_until).toISOString()).toBe(leaseUntil.toISOString());

            // …and comes back merged.
            const read = await deps.getPostById('vox-pop', 'aaaaaaaaaaaaa');
            expect(read?.processing?.leaseUntil).toEqual(leaseUntil);
        });

        it('does not clobber processing state when re-saving a record without it', async () => {
            // The hazard the upsert's `coalesce` guards. Firestore's whole-doc
            // `set` would have wiped the worker's column here.
            await deps.savePost(
                post({ processing: { transcribe: 'ready', updatedAt: new Date() } }),
            );
            await deps.savePost(post({ text: 'edited' }));
            const read = await deps.getPostById('vox-pop', 'aaaaaaaaaaaaa');
            expect(read?.text).toBe('edited');
            expect(read?.processing?.transcribe).toBe('ready');
        });

        it('rejects a record whose kind contradicts its reply fields', async () => {
            // The Zod refine is mirrored by a CHECK constraint, so the database
            // refuses what the schema refuses. Firestore could not express this.
            await expect(
                deps.savePost({ ...post(), kind: 'reply' } as AudioPostRecord),
            ).rejects.toThrow();
        });
    });

    describe('pagination', () => {
        const ids = ['aaaaaaaaaaaa1', 'aaaaaaaaaaaa2', 'aaaaaaaaaaaa3', 'aaaaaaaaaaaa4'];

        beforeEach(async () => {
            for (const [i, id] of ids.entries()) {
                await deps.savePost(
                    post({ id, createdAt: new Date(Date.UTC(2026, 7, i + 1)) }),
                );
            }
        });

        it('lists newest first', async () => {
            const page = await deps.queryByAuthor('vox-pop', 'user-1');
            expect(page.map((p) => p.id)).toEqual([...ids].reverse());
        });

        it('pages forward with a cursor without repeating or dropping', async () => {
            const first = await deps.queryByAuthor('vox-pop', 'user-1', { limit: 2 });
            expect(first.map((p) => p.id)).toEqual(['aaaaaaaaaaaa4', 'aaaaaaaaaaaa3']);

            const second = await deps.queryByAuthor('vox-pop', 'user-1', {
                limit: 2,
                cursorId: first[first.length - 1].id,
            });
            expect(second.map((p) => p.id)).toEqual(['aaaaaaaaaaaa2', 'aaaaaaaaaaaa1']);
        });

        it('ignores a cursor pointing at a row that does not exist', async () => {
            // Matches Firestore's `snap.exists ? startAfter(snap) : q`. Without
            // the `not exists` arm the row-comparison against an empty subquery
            // is NULL and the page comes back silently empty.
            const page = await deps.queryByAuthor('vox-pop', 'user-1', {
                cursorId: 'zzzzzzzzzzzzz',
            });
            expect(page).toHaveLength(4);
        });

        it('filters by kind', async () => {
            await deps.savePost(reply('bbbbbbbbbbbb1'));
            const prompts = await deps.queryByAuthor('vox-pop', 'user-1', { kind: 'prompt' });
            const replies = await deps.queryByAuthor('vox-pop', 'user-1', { kind: 'reply' });
            expect(prompts).toHaveLength(4);
            expect(replies).toHaveLength(1);
        });

        it('scopes every list by tenant', async () => {
            await expect(deps.queryByAuthor('other-app', 'user-1')).resolves.toHaveLength(0);
        });
    });

    describe('queryReplies', () => {
        it('returns oldest first — thread reading order', async () => {
            for (const [i, id] of ['ccccccccccc01', 'ccccccccccc02', 'ccccccccccc03'].entries()) {
                await deps.savePost(reply(id, { createdAt: new Date(Date.UTC(2026, 7, i + 1)) }));
            }
            const page = await deps.queryReplies(
                'vox-pop',
                'at://did:web:example.com/c/parent',
            );
            expect(page.map((p) => p.id)).toEqual([
                'ccccccccccc01',
                'ccccccccccc02',
                'ccccccccccc03',
            ]);
        });
    });

    describe('queryByRootAuthor', () => {
        it('returns only replies whose root author matches', async () => {
            await deps.savePost(reply('ddddddddddd01'));
            await deps.savePost(reply('ddddddddddd02', { rootAuthorId: 'someone-else' }));
            const page = await deps.queryByRootAuthor('vox-pop', 'user-root');
            expect(page.map((p) => p.id)).toEqual(['ddddddddddd01']);
        });
    });

    describe('getTranscriptsBySubjectUris', () => {
        async function insertTranscript(id: string, uri: string) {
            const record = {
                id,
                subject: { uri, cid: 'bafyreisubject' },
                transcript: { segments: [{ startMs: 0, endMs: 10, text: 'hi' }], text: 'hi' },
                createdAt: new Date('2026-08-01T00:00:00.000Z'),
            };
            await db.query(
                'insert into audio_transcripts (id, record, created_at) values ($1, $2::jsonb, $3)',
                [id, JSON.stringify(record), record.createdAt],
            );
        }

        it('batches well past the old 30-item Firestore `in` cap in one statement', async () => {
            // FIRESTORE_IN_LIMIT chunked at 30 and fanned out with Promise.all.
            // 75 here would have been three round trips; `= any($1)` is one.
            const uris: string[] = [];
            for (let i = 0; i < 75; i++) {
                const uri = `at://did:web:example.com/c/post${i}`;
                uris.push(uri);
                await insertTranscript(`t${String(i).padStart(12, '0')}`, uri);
            }
            const map = await deps.getTranscriptsBySubjectUris(uris);
            expect(map.size).toBe(75);
        });

        it('omits subjects with no transcript and dedupes the input', async () => {
            await insertTranscript('t00000000000a', 'at://did:web:example.com/c/has');
            const map = await deps.getTranscriptsBySubjectUris([
                'at://did:web:example.com/c/has',
                'at://did:web:example.com/c/has',
                'at://did:web:example.com/c/none',
                '',
            ]);
            expect(map.size).toBe(1);
            expect(map.has('at://did:web:example.com/c/has')).toBe(true);
        });

        it('returns an empty map for no input without querying', async () => {
            await expect(deps.getTranscriptsBySubjectUris([])).resolves.toEqual(new Map());
        });
    });

    describe('CID stability through jsonb', () => {
        it('preserves the record CID across a write/read round trip', async () => {
            // The property db/schema.sql § Open asks for. jsonb does not
            // preserve key order (DAG-CBOR canonicalises, so that is fine) but
            // it DOES store numbers as `numeric`, which is wider than JS —
            // a coercion here would change the record and therefore its CID,
            // silently invalidating every StrongRef pointing at it.
            const record = post({
                processing: undefined,
                langs: ['en', 'fr'],
                embed: {
                    $type: 'dev.antiphony.embed.audio',
                    audio: {
                        $type: 'blob',
                        ref: { $link: 'bafkreiaudio' },
                        mimeType: 'audio/webm',
                        size: 1234567,
                    },
                    durationMs: 98765,
                    waveform: [0, 17, 100, 3, 42],
                },
            } as Partial<AudioPostRecord>);

            const before = await cidForRecord(
                JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
            );
            await deps.savePost(record);
            const read = await deps.getPostById('vox-pop', record.id);
            const after = await cidForRecord(
                JSON.parse(JSON.stringify(read)) as Record<string, unknown>,
            );

            expect(after).toBe(before);
        });

        it('does not widen integers into floats', async () => {
            // The specific numeric hazard, isolated: a large integer coming
            // back as 1.234567e6 would encode differently in DAG-CBOR.
            await deps.savePost(post({ embed: {
                $type: 'dev.antiphony.embed.audio',
                audio: {
                    $type: 'blob',
                    ref: { $link: 'bafkreiaudio' },
                    mimeType: 'audio/webm',
                    size: 9007199254740991,
                },
            } } as Partial<AudioPostRecord>));
            const read = await deps.getPostById('vox-pop', 'aaaaaaaaaaaaa');
            expect(read?.embed?.audio.size).toBe(9007199254740991);
            expect(Number.isInteger(read?.embed?.audio.size)).toBe(true);
        });
    });
});
