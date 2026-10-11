import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { AudioPostRecord } from 'shared/types/audio';
import type { SpaceKey } from 'shared/types/spaces';
import type { AudioPostDependencies } from '../ports/audio-posts-dependencies';

/**
 * The storage half of the `AudioPostDependencies` port, as one suite every
 * implementation runs: the in-memory one the service tests lean on
 * (`in-memory-audio-post-dependencies.test.ts`) and the Postgres
 * binding (`apps/core-api/.../postgres/audio-posts-dependencies.contract.test.ts`).
 *
 * Why it exists: service tests run against an in-memory store and route tests
 * mock the services, so anything the fake does that Postgres does not is a bug
 * only production can find. The two had already drifted on the one case that
 * matters most here — a post id another tenant holds — where the fake stored
 * both posts and Postgres stored neither while reporting success.
 *
 * Covered: persistence, tenant scoping, upsert semantics, the processing
 * patch, and list ordering and paging. Not covered, on purpose: the methods
 * whose answer is deployment configuration rather than stored state
 * (`getAppDid`, `resolveAudioUrl`, `getBlobSpace`, `cidForRecord`, `now`,
 * `newPostId`), and transcripts, which are written through the processing
 * port.
 */

export interface ContractSubject {
    deps: AudioPostDependencies;
    /** Create a space so a post can be placed in it (Postgres has a foreign key). */
    seedSpace(originAppId: string, key: SpaceKey): Promise<void>;
}

export interface ContractHooks {
    /** A fresh subject. Called once; `reset` empties it between cases. */
    setup(): Promise<ContractSubject>;
    reset(): Promise<void>;
    teardown?(): Promise<void>;
}

const TENANT = 'vox-pop';
const OTHER = 'other-app';
const AUTHORITY = 'did:web:vox-pop.example';

function post(over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return {
        id: '3kpost2aaaaaa',
        cid: 'bafyreipost',
        originAppId: TENANT,
        authorId: 'author-1',
        kind: 'prompt',
        text: 'a question',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...over,
    } as AudioPostRecord;
}

const PARENT_URI = `at://${AUTHORITY}/dev.antiphony.audio.post/3kpost2aaaaaa`;

function reply(id: string, over: Partial<AudioPostRecord> = {}): AudioPostRecord {
    return post({
        id,
        kind: 'reply',
        authorId: 'responder',
        rootAuthorId: 'author-1',
        threadParticipants: ['author-1', 'responder'],
        reply: {
            root: { uri: PARENT_URI, cid: 'bafyreipost' },
            parent: { uri: PARENT_URI, cid: 'bafyreipost' },
        },
        ...over,
    });
}

const day = (n: number) => new Date(Date.UTC(2026, 7, n));

export function audioPostDependenciesContract(name: string, hooks: ContractHooks): void {
    describe(`AudioPostDependencies contract — ${name}`, () => {
        let subject: ContractSubject;
        let deps: AudioPostDependencies;

        beforeEach(async () => {
            subject ??= await hooks.setup();
            deps = subject.deps;
            await hooks.reset();
        });
        afterAll(async () => {
            await hooks.teardown?.();
        });

        describe('savePost / getPostById', () => {
            it('reads back what it saved', async () => {
                const record = post({ title: 'Headline', langs: ['en'], selfLabels: ['nudity'] });
                await deps.savePost(record);
                expect(await deps.getPostById(TENANT, record.id)).toEqual(record);
            });

            it('reads back a reply with its StrongRefs and branch facets', async () => {
                const record = reply('3kreply2aaaaa');
                await deps.savePost(record);
                expect(await deps.getPostById(TENANT, record.id)).toEqual(record);
            });

            it('reads back a post’s space placement', async () => {
                const space = { type: 'game.bardcast.space.campaign', skey: '3kcampaign2abc' };
                await subject.seedSpace(TENANT, space);
                const record = post({ space: { ...space, authorSegment: AUTHORITY } });
                await deps.savePost(record);
                expect((await deps.getPostById(TENANT, record.id))?.space).toEqual(record.space);
            });

            it('answers null for a post that does not exist, or a blank id', async () => {
                expect(await deps.getPostById(TENANT, '3knothere2aaa')).toBeNull();
                expect(await deps.getPostById(TENANT, '')).toBeNull();
            });

            it('hides a post from every other tenant', async () => {
                await deps.savePost(post());
                expect(await deps.getPostById(OTHER, post().id)).toBeNull();
            });

            it('rejects a post whose id another tenant holds, and leaves theirs alone', async () => {
                // Resolving here is how a create was reported for a post that
                // was never stored.
                await deps.savePost(post({ text: 'theirs' }));
                await expect(deps.savePost(post({ originAppId: OTHER, text: 'mine' }))).rejects.toThrow();

                expect((await deps.getPostById(TENANT, post().id))?.text).toBe('theirs');
                expect(await deps.getPostById(OTHER, post().id)).toBeNull();
            });

            it('upserts within a tenant', async () => {
                await deps.savePost(post({ text: 'first' }));
                await deps.savePost(post({ text: 'second' }));
                expect((await deps.getPostById(TENANT, post().id))?.text).toBe('second');
            });

            it('keeps processing state when re-saving a record that carries none', async () => {
                // The processing worker owns that state; a save that never
                // read it must not erase it.
                const processing = { transcribe: 'ready' as const, updatedAt: day(2) };
                await deps.savePost(post({ processing }));
                await deps.savePost(post({ text: 'edited' }));

                const read = await deps.getPostById(TENANT, post().id);
                expect(read?.text).toBe('edited');
                expect(read?.processing).toEqual(processing);
            });
        });

        describe('patchProcessingState', () => {
            it('merges a patch over the stored state, leaving sibling stages alone', async () => {
                await deps.savePost(post({ processing: { transcribe: 'pending', waveform: 'pending', updatedAt: day(1) } }));
                await deps.patchProcessingState!(TENANT, post().id, { transcribe: 'ready' });

                const read = await deps.getPostById(TENANT, post().id);
                expect(read?.processing).toMatchObject({ transcribe: 'ready', waveform: 'pending' });
                expect(read?.processing?.updatedAt.getTime()).toBeGreaterThan(day(1).getTime());
                expect(read?.text).toBe(post().text);
            });

            it('rejects a patch for a missing post or another tenant’s', async () => {
                await deps.savePost(post({ processing: { transcribe: 'pending', updatedAt: day(1) } }));
                await expect(deps.patchProcessingState!(TENANT, '3knothere2aaa', { transcribe: 'ready' })).rejects.toThrow();
                await expect(deps.patchProcessingState!(OTHER, post().id, { transcribe: 'ready' })).rejects.toThrow();
                expect((await deps.getPostById(TENANT, post().id))?.processing?.transcribe).toBe('pending');
            });
        });

        describe('queryByAuthor', () => {
            const ids = ['3kpost2aaaaa1', '3kpost2aaaaa2', '3kpost2aaaaa3', '3kpost2aaaaa4'];
            beforeEach(async () => {
                for (const [i, id] of ids.entries()) await deps.savePost(post({ id, createdAt: day(i + 1) }));
            });
            const listed = async (...args: Parameters<AudioPostDependencies['queryByAuthor']>) =>
                (await deps.queryByAuthor(...args)).map((p) => p.id);

            it('lists newest first', async () => {
                expect(await listed(TENANT, 'author-1')).toEqual([...ids].reverse());
            });

            it('pages with a cursor, neither repeating nor dropping a post', async () => {
                const first = await listed(TENANT, 'author-1', { limit: 2 });
                const second = await listed(TENANT, 'author-1', { limit: 2, cursorId: first[1] });
                expect([...first, ...second]).toEqual([...ids].reverse());
            });

            it('breaks a createdAt tie by id, so a page boundary inside the tie is stable', async () => {
                await deps.savePost(post({ id: '3kpost2aaaaa0', createdAt: day(4) }));
                const all = await listed(TENANT, 'author-1');
                const first = await listed(TENANT, 'author-1', { limit: 1 });
                const rest = await listed(TENANT, 'author-1', { cursorId: first[0] });
                expect([...first, ...rest]).toEqual(all);
            });

            it('starts over from a cursor it does not know, or another tenant’s', async () => {
                await deps.savePost(post({ id: '3kforeign2aaa', originAppId: OTHER, createdAt: day(3) }));
                expect(await listed(TENANT, 'author-1', { cursorId: '3knothere2aaa' })).toEqual([...ids].reverse());
                expect(await listed(TENANT, 'author-1', { cursorId: '3kforeign2aaa' })).toEqual([...ids].reverse());
            });

            it('filters by kind, and scopes by tenant and author', async () => {
                await deps.savePost(reply('3kreply2aaaaa', { authorId: 'author-1', createdAt: day(9) }));
                expect(await listed(TENANT, 'author-1', { kind: 'reply' })).toEqual(['3kreply2aaaaa']);
                expect(await listed(TENANT, 'author-1', { kind: 'prompt' })).toEqual([...ids].reverse());
                expect(await listed(OTHER, 'author-1')).toEqual([]);
                expect(await listed(TENANT, 'someone-else')).toEqual([]);
            });
        });

        describe('queryReplies', () => {
            it('lists one parent’s replies oldest first, in the tenant only', async () => {
                await deps.savePost(reply('3kreply2aaaa3', { createdAt: day(3) }));
                await deps.savePost(reply('3kreply2aaaa1', { createdAt: day(1) }));
                await deps.savePost(reply('3kreply2aaaa2', { createdAt: day(2) }));
                await deps.savePost(reply('3kforeign2aaa', { originAppId: OTHER, createdAt: day(4) }));
                const elsewhere = { uri: `at://${AUTHORITY}/dev.antiphony.audio.post/3kelse2aaaaaa`, cid: 'bafyreielse' };
                await deps.savePost(reply('3kreply2aaaa4', { reply: { root: elsewhere, parent: elsewhere } }));

                const page = await deps.queryReplies(TENANT, PARENT_URI);
                expect(page.map((p) => p.id)).toEqual(['3kreply2aaaa1', '3kreply2aaaa2', '3kreply2aaaa3']);
                expect((await deps.queryReplies(TENANT, PARENT_URI, { limit: 1, cursorId: '3kreply2aaaa1' })).map((p) => p.id))
                    .toEqual(['3kreply2aaaa2']);
            });
        });

        describe('queryByRootAuthor', () => {
            it('lists replies under that author’s threads, newest first, and never prompts', async () => {
                await deps.savePost(post());
                await deps.savePost(reply('3kreply2aaaa1', { createdAt: day(1) }));
                await deps.savePost(reply('3kreply2aaaa2', { createdAt: day(2) }));
                await deps.savePost(reply('3kreply2aaaa3', { rootAuthorId: 'someone-else' }));
                await deps.savePost(reply('3kforeign2aaa', { originAppId: OTHER }));

                const page = await deps.queryByRootAuthor(TENANT, 'author-1');
                expect(page.map((p) => p.id)).toEqual(['3kreply2aaaa2', '3kreply2aaaa1']);
            });
        });
    });
}
