import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostDeletionService } from '@antiphony/core/services/post-deletion';
import { RemotePostService, REMOTE_GONE_CONFIRM_MS } from '@antiphony/core/services/remote-posts';
import { makeStorageService } from '@antiphony/core/services/storage';
import type { PublicRepoPort, RepoResult, FetchedRecord } from '@antiphony/core/ports/public-repo';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresRemotePostDependencies } from './remote-posts-dependencies.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from './audio-processing-dependencies.js';
import { postgresPostDeletionDependencies } from './post-deletion-dependencies.js';
import { r2BlobStore } from '../r2/blob-store.js';
import { createFakeBucket, type FakeBucket } from '../r2/testing/fake-bucket.js';
import { cidForBytes, cidForRepoRecord } from '../../../lib/cid.js';

/**
 * Remote posts (migration 0006, specs/audio-service-mode.md Phase A) through
 * the real service, against Postgres 18 (PGlite), a fake R2 bucket and a fake
 * repo serving real records with real CIDs.
 */

const TENANT = 'vox-pop';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const URI = `at://${DID}/dev.antiphony.audio.post/3kremote00001`;
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3]);

async function audioRecord(bytes: Uint8Array, over: Record<string, unknown> = {}) {
    return {
        $type: 'dev.antiphony.audio.post',
        text: 'what did you hear?',
        embed: {
            $type: 'dev.antiphony.embed.audio',
            audio: { $type: 'blob', ref: { $link: await cidForBytes(bytes) }, mimeType: 'audio/mp4', size: bytes.length },
        },
        createdAt: '2026-11-02T10:00:00.000Z',
        ...over,
    };
}

describe('remote posts (migration 0006)', () => {
    let db: TestDatabase;
    let bucket: FakeBucket;
    let clock: { now: Date };
    let records: Map<string, RepoResult<FetchedRecord>>;
    let blobs: Map<string, Uint8Array>;

    beforeAll(async () => {
        db = await createTestDatabase();
    });
    afterAll(async () => db.close());
    beforeEach(async () => {
        await db.truncate();
        bucket = createFakeBucket();
        clock = { now: new Date('2026-11-02T12:00:00.000Z') };
        records = new Map();
        blobs = new Map();
    });

    const storage = () => makeStorageService(r2BlobStore({ bucket, bucketName: 'test' }));
    const deps = () => postgresRemotePostDependencies(db, storage(), () => clock.now);
    const repo: PublicRepoPort = {
        getRecord: async (ref) =>
            records.get(`at://${ref.did}/${ref.collection}/${ref.rkey}`) ?? { ok: false, kind: 'gone', reason: 'RecordNotFound' },
        getBlob: async (_did, cid) => {
            const bytes = blobs.get(cid);
            return bytes ? { ok: true, value: { bytes } } : { ok: false, kind: 'gone', reason: 'BlobNotFound' };
        },
    };
    const service = () => new RemotePostService(deps(), repo);
    const drain = () =>
        new PostDeletionService(
            postgresPostDeletionDependencies(db, postgresAudioPostDependencies(db, storage()), storage()),
        ).drainAll();

    async function publish(uri: string, bytes: Uint8Array, over: Record<string, unknown> = {}) {
        const value = await audioRecord(bytes, over);
        const cid = await cidForRepoRecord(value);
        records.set(uri, { ok: true, value: { cid, value } });
        blobs.set(await cidForBytes(bytes), bytes);
        return cid;
    }
    const hasBlob = async (bytes: Uint8Array) => bucket.objects.has(`blobs/${TENANT}/${await cidForBytes(bytes)}`);

    it('registers a record, copies its blob, and hydrates a view with a stable URL', async () => {
        const cid = await publish(URI, MP4);
        const { row, outcome } = await service().register(TENANT, { uri: URI, cid });

        expect(outcome).toBe('created');
        expect(await hasBlob(MP4)).toBe(true);
        expect(row).toMatchObject({ uri: URI, cid, repoDid: DID, collection: 'dev.antiphony.audio.post', blobPrivate: false });
        expect(row.registeredAt).toBeInstanceOf(Date);

        const [view] = await service().hydrate(TENANT, [row]);
        // The same stable, unsigned proxy URL a flat hosted post gets.
        expect(view.embed?.url).toMatch(/\/api\/v1\/audio\?url=blobs%2Fvox-pop%2Fbafkrei[a-z2-7]+$/);
        expect(view.embed?.url).not.toMatch(/sig=|exp=/);
    });

    it('stores, reads back and merges processing, lease and all', async () => {
        const cid = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid, processing: { transcribe: 'pending', reprocess: true } });
        const { row } = await service().requestProcessing(TENANT, URI, { waveform: 'pending' });
        expect(row.processing).toMatchObject({ transcribe: 'pending', waveform: 'pending', reprocess: true });
        expect(row.processing?.updatedAt).toBeInstanceOf(Date);
    });

    it('keeps tenants apart, and lets two tenants register the same URI', async () => {
        const cid = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid });
        await service().register('bardcast', { uri: URI, cid });
        expect(await deps().getRemotePost('bardcast', URI)).not.toBeNull();
        expect(await service().delete('bardcast', URI)).toBe(true);
        expect(await deps().getRemotePost(TENANT, URI)).not.toBeNull();
    });

    it('pages the registered replies under a root, oldest first', async () => {
        const rootCid = await publish(URI, MP4);
        const replyUris: string[] = [];
        for (let i = 0; i < 3; i++) {
            const uri = `at://did:plc:zyxwvutsrqponmlkjihgfedc/dev.antiphony.audio.post/3kreply00000${i}`;
            const cid = await publish(uri, MP4, {
                createdAt: `2026-11-02T10:0${i}:00.000Z`,
                reply: { root: { uri: URI, cid: rootCid }, parent: { uri: URI, cid: rootCid } },
            });
            await service().register(TENANT, { uri, cid });
            replyUris.push(uri);
        }
        const first = await service().thread(TENANT, URI, { limit: 2 });
        expect(first.replies.map((r) => r.uri)).toEqual(replyUris.slice(0, 2));
        expect(first.nextCursor).toBe(replyUris[1]);
        const second = await service().thread(TENANT, URI, { limit: 2, cursor: first.nextCursor! });
        expect(second.replies.map((r) => r.uri)).toEqual([replyUris[2]]);
        expect(second.nextCursor).toBeNull();
    });

    it('deletes the row, its transcript and its audio, and keeps a content-free ledger row', async () => {
        const cid = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid });
        await postgresAudioProcessingDependencies(db, storage()).saveTranscript(TENANT, {
            id: '3ktranscript01',
            subject: { uri: URI, cid },
            transcript: { segments: [] },
            createdAt: clock.now,
        });

        expect(await service().delete(TENANT, URI)).toBe(true);
        expect(await db.query('select 1 from audio_transcripts')).toEqual([]);
        expect(await db.query('select origin_app_id, uri, reason from deleted_remote_posts')).toEqual([
            { origin_app_id: TENANT, uri: URI, reason: 'tenant' },
        ]);
        await drain();
        expect(await hasBlob(MP4)).toBe(false);
        await expect(service().get(TENANT, URI)).rejects.toMatchObject({ status: 410 });

        // Re-registering a record that still exists clears the ledger.
        await service().register(TENANT, { uri: URI, cid });
        expect(await db.query('select 1 from deleted_remote_posts')).toEqual([]);
    });

    it('removes a post after two "gone" reads an hour apart, through the sweep', async () => {
        const cid = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid });
        records.delete(URI);

        await service().sweep(10);
        expect((await deps().getRemotePost(TENANT, URI))?.goneAt).toEqual(clock.now);

        clock.now = new Date(clock.now.getTime() + REMOTE_GONE_CONFIRM_MS);
        expect(await service().sweep(10)).toMatchObject({ removed: 1 });
        expect(await deps().getRemotePost(TENANT, URI)).toBeNull();
        expect((await deps().getDeletedRemotePost(TENANT, URI))?.reason).toBe('gone');
    });

    it('takes an edit with new audio: the old blob goes, unless something still uses it', async () => {
        const cid1 = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid: cid1, processing: { transcribe: 'pending' } });

        const edited = new Uint8Array([...MP4, 9]);
        const cid2 = await publish(URI, edited);
        const { row, outcome, dispatch } = await service().register(TENANT, { uri: URI, cid: cid2 });
        expect(outcome).toBe('updated');
        expect(dispatch).toBe(true);
        expect(row.blob.cid).toBe(await cidForBytes(edited));

        await drain();
        expect(await hasBlob(MP4)).toBe(false);
        expect(await hasBlob(edited)).toBe(true);
    });
});
