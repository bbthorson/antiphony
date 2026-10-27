import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AudioPostRecord } from 'shared/types/audio';
import { buildPostUri } from '@antiphony/core/services/audio-posts';
import { PostDeletionService } from '@antiphony/core/services/post-deletion';
import { makeStorageService } from '@antiphony/core/services/storage';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from './audio-processing-dependencies.js';
import { postgresPostDeletionDependencies } from './post-deletion-dependencies.js';
import { postgresSpaceDependencies } from './space-dependencies.js';
import { r2BlobStore } from '../r2/blob-store.js';
import { createFakeBucket, type FakeBucket } from '../r2/testing/fake-bucket.js';

vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: (originAppId: string) => `did:web:${originAppId}.example`,
}));

/**
 * Deletion (migration 0003, specs/deletion.md) against real Postgres 18
 * (PGlite) and a fake R2 bucket, through the real service: the one-statement
 * delete, the ledger, the blob queue and its drain, and the two cases the spec
 * exists for — a blob another post still references, and the replies below a
 * deleted post.
 */

const TENANT = 'voxpop';
const DID = `did:web:${TENANT}.example`;
const REPLY_SPACE = { type: 'audio.voxpop.space.replies', skey: '3kprompt00000a', authorSegment: DID };

let seq = 0;

function audio(cid: string) {
    return {
        $type: 'dev.antiphony.embed.audio' as const,
        audio: { $type: 'blob' as const, ref: { $link: cid }, mimeType: 'audio/webm', size: 3 },
    };
}

function prompt(over: Partial<AudioPostRecord> & { audioCid?: string } = {}): AudioPostRecord {
    seq += 1;
    const { audioCid, ...rest } = over;
    return {
        id: `3kprompt${String(seq).padStart(6, '0')}`,
        cid: `bafyprompt${seq}`,
        originAppId: TENANT,
        authorId: 'creator',
        kind: 'prompt',
        text: 'what should we cover?',
        createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)),
        ...(audioCid ? { embed: audio(audioCid) } : {}),
        ...rest,
    } as AudioPostRecord;
}

function reply(
    parent: AudioPostRecord,
    over: Partial<AudioPostRecord> & { audioCid?: string } = {},
): AudioPostRecord {
    seq += 1;
    const { audioCid, ...rest } = over;
    const parentRef = { uri: buildPostUri(DID, parent.id, parent.space), cid: parent.cid };
    return {
        id: `3kreply0${String(seq).padStart(6, '0')}`,
        cid: `bafyreply${seq}`,
        originAppId: TENANT,
        authorId: 'listener',
        kind: 'reply',
        rootAuthorId: parent.kind === 'prompt' ? parent.authorId : parent.rootAuthorId,
        reply: { root: parent.kind === 'prompt' ? parentRef : parent.reply!.root, parent: parentRef },
        text: '',
        createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)),
        ...(audioCid ? { embed: audio(audioCid) } : {}),
        ...rest,
    } as AudioPostRecord;
}

describe('post deletion (migration 0003)', () => {
    let db: TestDatabase;
    let bucket: FakeBucket;
    let posts: ReturnType<typeof postgresAudioPostDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
    });
    afterAll(async () => db.close());
    beforeEach(async () => {
        await db.truncate();
        bucket = createFakeBucket();
        posts = postgresAudioPostDependencies(db, { stat: async () => null });
    });

    const storage = () => makeStorageService(r2BlobStore({ bucket, bucketName: 'test' }));
    const deps = (store = storage()) => postgresPostDeletionDependencies(db, posts, store);
    const service = (store = storage()) => new PostDeletionService(deps(store));

    /** Seed a blob and its mp3 rendition, the two objects a CID can have. */
    async function storeBlob(cid: string, originAppId = TENANT) {
        await bucket.put(`blobs/${originAppId}/${cid}`, new Uint8Array([1, 2, 3]));
        await bucket.put(`renditions/${originAppId}/${cid}.mp3`, new Uint8Array([4, 5]));
    }
    const hasBlob = (cid: string, originAppId = TENANT) => bucket.objects.has(`blobs/${originAppId}/${cid}`);
    const hasRendition = (cid: string) => bucket.objects.has(`renditions/${TENANT}/${cid}.mp3`);
    const queued = async () =>
        (await db.query<{ cid: string }>(`select cid from blob_deletions order by cid`)).map((r) => r.cid);

    async function save(...records: AudioPostRecord[]) {
        for (const r of records) await posts.savePost(r);
    }

    async function createReplySpace() {
        await db.query(
            `insert into spaces (origin_app_id, space_type, skey, read_policy, write_policy)
             values ($1, $2, $3, 'managing-app', 'managing-app')`,
            [TENANT, REPLY_SPACE.type, REPLY_SPACE.skey],
        );
    }

    it('removes the row, its transcript, its blobs and renditions, and keeps a content-free ledger row', async () => {
        const p = prompt({ audioCid: 'bafyoriginal' });
        await save(p);
        await storeBlob('bafyoriginal');
        await storeBlob('bafyintermediate');
        await storeBlob('bafyprocessed');
        await posts.patchProcessingState!(TENANT, p.id, {
            denoise: 'ready',
            trim: 'ready',
            processedBlobCid: 'bafyprocessed',
            derivedBlobCids: ['bafyintermediate', 'bafyprocessed'],
        });
        const uri = buildPostUri(DID, p.id);
        await postgresAudioProcessingDependencies(db, storage()).saveTranscript({
            id: '3ktranscript01',
            subject: { uri, cid: p.cid },
            transcript: { segments: [{ startMs: 0, endMs: 10, text: 'hello' }] },
            createdAt: new Date('2026-10-20T00:00:00.000Z'),
        });

        const result = await service().deletePost(TENANT, p.id, 'delete');

        expect(result).toEqual({
            status: 'deleted',
            complete: true,
            deleted: [{ postId: p.id, uri, kind: 'prompt' }],
            kept: [],
        });
        expect(await posts.getPostById(TENANT, p.id)).toBeNull();
        expect(await db.query(`select 1 from audio_transcripts`)).toHaveLength(0);
        for (const cid of ['bafyoriginal', 'bafyintermediate', 'bafyprocessed']) {
            expect(hasBlob(cid), cid).toBe(false);
            expect(hasRendition(cid), `${cid}.mp3`).toBe(false);
        }
        expect(await queued()).toEqual([]);

        const [ledger] = await db.query<Record<string, unknown>>(`select * from deleted_posts`);
        // Nothing about the content: no text, no CID, no author.
        expect(Object.keys(ledger).sort()).toEqual(['deleted_at', 'kind', 'origin_app_id', 'post_id', 'uri']);
        expect(ledger).toMatchObject({ origin_app_id: TENANT, post_id: p.id, uri, kind: 'prompt' });
        expect(await deps().getDeletedPost(TENANT, p.id)).toMatchObject({ postId: p.id, uri, kind: 'prompt' });
    });

    it('never deletes a blob another post in the tenant still references', async () => {
        const a = prompt({ audioCid: 'bafyshared' });
        const b = prompt({ audioCid: 'bafyshared' });
        await save(a, b);
        await storeBlob('bafyshared');

        await service().deletePost(TENANT, a.id, 'delete');
        expect(hasBlob('bafyshared')).toBe(true);
        expect(hasRendition('bafyshared')).toBe(true);
        expect(await queued()).toEqual([]); // dropped from the queue, not deleted

        await service().deletePost(TENANT, b.id, 'delete');
        expect(hasBlob('bafyshared')).toBe(false);
        expect(hasRendition('bafyshared')).toBe(false);
    });

    it("counts another post's processed and derived variants as references", async () => {
        const a = prompt({ audioCid: 'bafyvariant' });
        const b = prompt({ audioCid: 'bafyotheroriginal' });
        const c = prompt({ audioCid: 'bafythirdoriginal' });
        await save(a, b, c);
        await posts.patchProcessingState!(TENANT, b.id, { denoise: 'ready', processedBlobCid: 'bafyvariant' });
        await posts.patchProcessingState!(TENANT, c.id, { denoise: 'ready', derivedBlobCids: ['bafyvariant'] });
        await storeBlob('bafyvariant');

        await service().deletePost(TENANT, a.id, 'delete');
        expect(hasBlob('bafyvariant')).toBe(true);

        await service().deletePost(TENANT, b.id, 'delete');
        expect(hasBlob('bafyvariant')).toBe(true); // c's derived list still names it

        await service().deletePost(TENANT, c.id, 'delete');
        expect(hasBlob('bafyvariant')).toBe(false);
    });

    it("ignores another tenant's post with the same CID: its bytes are a different object", async () => {
        const ours = prompt({ audioCid: 'bafysamebytes' });
        const theirs = prompt({ audioCid: 'bafysamebytes', originAppId: 'bardcast' });
        await save(ours, theirs);
        await storeBlob('bafysamebytes');
        await storeBlob('bafysamebytes', 'bardcast');

        await service().deletePost(TENANT, ours.id, 'delete');

        expect(hasBlob('bafysamebytes')).toBe(false);
        expect(hasBlob('bafysamebytes', 'bardcast')).toBe(true);
        expect(await posts.getPostById('bardcast', theirs.id)).not.toBeNull();
    });

    it('under keep-with-did, keeps a reply with a DID in its reply space, with its audio, and erases the rest', async () => {
        await createReplySpace();
        const p = prompt({ id: REPLY_SPACE.skey, audioCid: 'bafyprompt' });
        const linked = reply(p, { space: REPLY_SPACE, authorDid: 'did:plc:linked', authorId: 'linked', audioCid: 'bafylinked' });
        const sms = reply(p, { space: REPLY_SPACE, authorId: 'sms', audioCid: 'bafysms' });
        const creatorAnswer = reply(sms, { space: REPLY_SPACE, authorId: 'creator', audioCid: 'bafyanswer' });
        await save(p, linked, sms, creatorAnswer);
        for (const cid of ['bafyprompt', 'bafylinked', 'bafysms', 'bafyanswer']) await storeBlob(cid);

        const result = await service().deletePost(TENANT, p.id, 'keep-with-did');

        expect(result!.deleted.map((d) => d.postId).sort()).toEqual([p.id, sms.id, creatorAnswer.id].sort());
        expect(result!.kept).toEqual([{ postId: linked.id, uri: buildPostUri(DID, linked.id, REPLY_SPACE) }]);
        // A spaced reply's ledger URI carries its space, as its view's did.
        expect(result!.deleted.find((d) => d.postId === sms.id)?.uri).toBe(buildPostUri(DID, sms.id, REPLY_SPACE));

        const kept = await posts.getPostById(TENANT, linked.id);
        expect(kept).toEqual(linked); // same record, same CID, same space
        expect(kept?.reply?.parent.uri).toBe(buildPostUri(DID, p.id)); // now dangling
        expect(hasBlob('bafylinked')).toBe(true);
        for (const cid of ['bafyprompt', 'bafysms', 'bafyanswer']) expect(hasBlob(cid), cid).toBe(false);

        // The space stays: it still holds the kept reply.
        const spaces = postgresSpaceDependencies(db);
        expect(await spaces.deleteSpace(TENANT, REPLY_SPACE)).toBe('not-empty');
    });

    it('deletes an empty space, and reports an absent one', async () => {
        await createReplySpace();
        const spaces = postgresSpaceDependencies(db);

        expect(await spaces.deleteSpace(TENANT, REPLY_SPACE)).toBe('deleted');
        expect(await spaces.getSpace(TENANT, REPLY_SPACE)).toBeNull();
        expect(await spaces.deleteSpace(TENANT, REPLY_SPACE)).toBe('absent');
    });

    it('is idempotent: a second deletePosts removes nothing and writes no second ledger row', async () => {
        const p = prompt({ audioCid: 'bafyonce' });
        await save(p);
        const d = deps();
        const target = [{ id: p.id, uri: buildPostUri(DID, p.id), kind: 'prompt' as const }];

        expect(await d.deletePosts(TENANT, target)).toEqual([p.id]);
        expect(await d.deletePosts(TENANT, target)).toEqual([]);
        expect(await db.query(`select 1 from deleted_posts`)).toHaveLength(1);
        expect(await service().deletePost(TENANT, p.id, 'delete')).toMatchObject({ status: 'already-deleted' });
    });

    it('leaves the queue intact when R2 fails, and a later drain finishes the job', async () => {
        const p = prompt({ audioCid: 'bafyretry' });
        await save(p);
        await storeBlob('bafyretry');
        const failing = { ...storage(), deleteObjects: async () => { throw new Error('R2 down'); } };

        const result = await new PostDeletionService(deps(failing), undefined, { error: () => {}, warn: () => {}, info: () => {} })
            .deletePost(TENANT, p.id, 'delete');

        expect(result!.status).toBe('deleted');
        expect(await queued()).toEqual(['bafyretry']);
        expect(hasBlob('bafyretry')).toBe(true);

        expect(await service().drainAll()).toEqual({ deleted: 1, retained: 0 });
        expect(hasBlob('bafyretry')).toBe(false);
        expect(await queued()).toEqual([]);
    });

    it('keeps a CID queued that was re-queued while a drain was deleting it', async () => {
        await db.query(`insert into blob_deletions (origin_app_id, cid) values ($1, 'bafyrequeued')`, [TENANT]);
        await storeBlob('bafyrequeued');
        // Stands in for a delete committing mid-drain: it re-queues the same
        // CID, which moves its timestamp, between the drain's read and its
        // removal of the queue row.
        const base = storage();
        const racing = {
            ...base,
            deleteObjects: async (paths: string[]) => {
                await base.deleteObjects(paths);
                await db.query(`update blob_deletions set enqueued_at = now() + interval '1 second'`);
            },
        };

        await deps(racing).drainBlobDeletions(null, 10);

        expect(await queued()).toEqual(['bafyrequeued']);
    });

    it('queues the blob a processing pass writes for a post deleted mid-pass', async () => {
        const p = prompt({ audioCid: 'bafysource' });
        await save(p);
        await service().deletePost(TENANT, p.id, 'delete');
        await storeBlob('bafylatevariant');

        const processing = postgresAudioProcessingDependencies(db, storage());
        await expect(
            processing.patchProcessingState(TENANT, p.id, {
                denoise: 'ready',
                processedBlobCid: 'bafylatevariant',
                derivedBlobCids: ['bafylatevariant'],
            }),
        ).rejects.toThrow(/not found/);

        expect(await queued()).toEqual(['bafylatevariant']);
        await service().drainAll();
        expect(hasBlob('bafylatevariant')).toBe(false);
    });

    it('erases an author across threads, through the same queue', async () => {
        const own = prompt({ audioCid: 'bafyown' });
        const toOwn = reply(own, { audioCid: 'bafytoown' });
        const other = prompt({ authorId: 'someone-else', audioCid: 'bafyother' });
        const mine = reply(other, { authorId: 'creator', audioCid: 'bafymine' });
        await save(own, toOwn, other, mine);
        for (const cid of ['bafyown', 'bafytoown', 'bafyother', 'bafymine']) await storeBlob(cid);

        const result = await service().eraseAuthor(TENANT, 'creator', 'delete', 100);

        expect(result.complete).toBe(true);
        expect(result.deleted.map((d) => d.postId).sort()).toEqual([own.id, toOwn.id, mine.id].sort());
        expect(hasBlob('bafyother')).toBe(true);
        for (const cid of ['bafyown', 'bafytoown', 'bafymine']) expect(hasBlob(cid), cid).toBe(false);
        expect(await posts.queryByAuthor(TENANT, 'creator')).toEqual([]);
    });
});
