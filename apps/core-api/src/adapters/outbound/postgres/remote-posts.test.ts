import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostDeletionService } from '@antiphony/core/services/post-deletion';
import { RemotePostService, REMOTE_GONE_CONFIRM_MS } from '@antiphony/core/services/remote-posts';
import { AudioProcessingService } from '@antiphony/core/services/audio-processing';
import { makeStorageService } from '@antiphony/core/services/storage';
import type { PublicRepoPort, RepoResult, FetchedRecord } from '@antiphony/core/ports/public-repo';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresRemotePostDependencies } from './remote-posts-dependencies.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from './audio-processing-dependencies.js';
import { postgresPostDeletionDependencies } from './post-deletion-dependencies.js';
import { postgresRemoteProcessingDependencies } from './remote-processing-dependencies.js';
import { r2BlobStore } from '../r2/blob-store.js';
import { createFakeBucket, type FakeBucket } from '../r2/testing/fake-bucket.js';
import { cidForBytes, cidForRepoRecord } from '../../../lib/cid.js';
import { blobSpaceMetadata } from '../../../lib/blob-space.js';

/**
 * Remote posts (migrations 0006 and 0008, specs/audio-service-mode.md Phases A
 * and B) through
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

    it('processes a remote post through the same service, keyed by URI, and the view shows the result', async () => {
        const cid = await publish(URI, MP4);
        await service().register(TENANT, { uri: URI, cid, processing: { transcribe: 'pending' } });
        const events: { uri: string; postId?: string }[] = [];

        const ran = await new AudioProcessingService(
            postgresRemoteProcessingDependencies(db, storage()),
            {
                transcriber: {
                    transcribe: async () => ({
                        transcript: { segments: [{ startMs: 0, endMs: 10, text: 'hi' }], text: 'hi' },
                        model: 'stub',
                    }),
                },
            },
            undefined,
            { notify: async (e) => void events.push(e) },
        ).process(TENANT, URI);

        expect(ran).toBe(true);
        expect(events).toEqual([expect.objectContaining({ uri: URI, stage: 'transcribe', status: 'ready' })]);
        expect(events[0]).not.toHaveProperty('postId');
        const [view] = await service().hydrate(TENANT, [await service().get(TENANT, URI)]);
        expect(view.embed).toMatchObject({ transcript: { text: 'hi' }, processing: { transcribe: 'ready' } });
        // The lease was given back.
        expect(await db.query('select lease_until from remote_posts')).toEqual([{ lease_until: null }]);
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

    describe('pushed space records (Phase B, migration 0008)', () => {
        const GROUP = 'did:plc:group0000000000000000000';
        const SPACE = { authority: GROUP, type: 'game.bardcast.space.campaign', skey: 'thornwood' };
        const SPACE_URI = `at://${GROUP}/space/${SPACE.type}/${SPACE.skey}/${DID}/dev.antiphony.audio.post/3kspace000001`;
        const path = async (bytes: Uint8Array) => `blobs/${TENANT}/${await cidForBytes(bytes)}`;
        const marking = async (bytes: Uint8Array) => bucket.objects.get(await path(bytes))?.customMetadata;

        /** The tenant uploaded the bytes it read from the space, with `remoteSpace`. */
        async function uploadForSpace(bytes: Uint8Array) {
            await storage().uploadFile(bytes, await path(bytes), 'audio/mp4', { metadata: blobSpaceMetadata(SPACE) });
        }
        async function push(bytes: Uint8Array) {
            const record = await audioRecord(bytes);
            return service().register(TENANT, { uri: SPACE_URI, cid: await cidForRepoRecord(record), record });
        }

        it('stores the space, how it was verified, and the author as the repo; plays signed', async () => {
            process.env.ANTIPHONY_PLAYBACK_SECRET = 'test-playback-secret-0123456789abcdef';
            try {
                await uploadForSpace(MP4);
                const { row } = await push(MP4);

                expect(row).toMatchObject({ uri: SPACE_URI, repoDid: DID, space: SPACE, verified: 'pushed', blobPrivate: true });
                expect(await db.query('select space, verified, repo_did from remote_posts')).toEqual([
                    { space: SPACE, verified: 'pushed', repo_did: DID },
                ]);
                const [view] = await service().hydrate(TENANT, [row]);
                expect(view).toMatchObject({ space: SPACE, verified: 'pushed', deletionCheck: 'tenant' });
                expect(view.embed?.url).toMatch(/sig=/);
            } finally {
                delete process.env.ANTIPHONY_PLAYBACK_SECRET;
            }
        });

        it('is left out of the sweep, which can not read it', async () => {
            await uploadForSpace(MP4);
            await push(MP4);
            expect(await deps().listForSweep(10)).toEqual([]);
            expect(await service().sweep(10)).toMatchObject({ checked: 0 });
            expect(await deps().getRemotePost(TENANT, SPACE_URI)).not.toBeNull();
        });

        it('counts only fetched public records as verified public references', async () => {
            const cid = await cidForBytes(MP4);
            await uploadForSpace(MP4);
            await push(MP4);
            expect(await deps().hasVerifiedPublicReference(TENANT, cid)).toBe(false);

            const publicCid = await publish(URI, MP4);
            await service().register(TENANT, { uri: URI, cid: publicCid });
            expect(await deps().hasVerifiedPublicReference(TENANT, cid)).toBe(true);
            expect(await deps().hasVerifiedPublicReference('bardcast', cid)).toBe(false);
        });

        it("turns private audio and its variants public on a verified public record, and keeps the space's playback signed", async () => {
            await uploadForSpace(MP4);
            await push(MP4);
            // Processing made a variant, marked like its original.
            const variant = new Uint8Array([...MP4, 42]);
            await storage().uploadFile(variant, await path(variant), 'audio/mp4', { metadata: blobSpaceMetadata(SPACE) });
            const variantCid = await cidForBytes(variant);
            await db.query(`update remote_posts set processing = $1::jsonb`, [
                JSON.stringify({ denoise: 'ready', processedBlobCid: variantCid, derivedBlobCids: [variantCid], updatedAt: clock.now }),
            ]);

            const publicCid = await publish(URI, MP4);
            await service().register(TENANT, { uri: URI, cid: publicCid });

            expect(await marking(MP4)).toBeUndefined();
            expect(await marking(variant)).toBeUndefined();
            expect(bucket.objects.get(await path(variant))?.bytes).toEqual(variant);
            expect(bucket.objects.get(await path(MP4))?.contentType).toBe('audio/mp4');
            expect((await deps().getRemotePost(TENANT, SPACE_URI))?.blobPrivate).toBe(true);
            expect((await deps().getRemotePost(TENANT, URI))?.blobPrivate).toBe(false);
        });

        it("marks a space record's processed variants for its space, authority included", async () => {
            await uploadForSpace(MP4);
            const record = await audioRecord(MP4);
            await service().register(TENANT, {
                uri: SPACE_URI,
                cid: await cidForRepoRecord(record),
                record,
                processing: { denoise: 'pending' },
            });
            const cleaned = new Uint8Array([...MP4, 7]);

            await new AudioProcessingService(postgresRemoteProcessingDependencies(db, storage()), {
                denoiser: { denoise: async () => ({ bytes: cleaned, mimeType: 'audio/mp4', model: 'stub' }) },
            }).process(TENANT, SPACE_URI);

            expect(await marking(cleaned)).toEqual(blobSpaceMetadata(SPACE));
        });

        it('refuses a pushed row with no space, and a space with no authority', async () => {
            const insert = (space: unknown, verified: string) =>
                db.query(
                    `insert into remote_posts (origin_app_id, uri, cid, repo_did, collection, rkey, record, blob_cid,
                                               mime_type, size, created_at, space, verified)
                     values ('t', 'at://x', 'c', 'did:plc:x', 'c', 'r', '{}', 'b', 'audio/mp4', 1, now(), $1::jsonb, $2)`,
                    [space === null ? null : JSON.stringify(space), verified],
                );
            await expect(insert(null, 'pushed')).rejects.toThrow(/remote_posts_pushed_is_space/);
            await expect(insert({ type: 'a.b.c', skey: 'k' }, 'pushed')).rejects.toThrow(/remote_posts_space_shape/);
            await expect(insert({ authority: 'did:plc:g', type: 'a.b.c', skey: 'k' }, 'guessed')).rejects.toThrow(/remote_posts_verified_valid/);
        });
    });
});
