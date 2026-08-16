import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresAudioPostDependencies } from './audio-posts-dependencies.js';
import { postgresAudioProcessingDependencies } from './audio-processing-dependencies.js';
import type { AudioPostRecord } from 'shared/types/audio';

vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:example.com',
}));
vi.mock('../firebase/core-services-firebase.js', () => ({
    StorageService: {
        getSignedUrl: async () => 'https://signed.example/audio',
        download: async () => null,
        uploadFile: async () => undefined,
    },
}));

/**
 * Postgres `AudioProcessingDependencies` against real Postgres 18 (PGlite).
 *
 * The lease carries almost all the risk here. Its port doc argues at length
 * that a non-atomic claim reintroduces the exact race the lease exists to
 * close, and that an unconditional release hands a third runner a post the
 * second is still working on. Both are now single statements, so both are
 * testable by actually running them concurrently rather than by reasoning about
 * a transaction.
 */

const TENANT = 'vox-pop';

function withProcessing(id: string, over: Record<string, unknown> = {}): AudioPostRecord {
    return {
        id,
        cid: 'bafyreiaaa',
        originAppId: TENANT,
        authorId: 'user-1',
        kind: 'prompt',
        text: 'hello',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        processing: { transcribe: 'pending', updatedAt: new Date('2026-08-01T00:00:00.000Z') },
        ...over,
    } as AudioPostRecord;
}

describe('postgresAudioProcessingDependencies', () => {
    let db: TestDatabase;
    let deps: ReturnType<typeof postgresAudioProcessingDependencies>;
    let posts: ReturnType<typeof postgresAudioPostDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        deps = postgresAudioProcessingDependencies(db);
        posts = postgresAudioPostDependencies(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    const future = () => new Date(Date.now() + 15 * 60 * 1000);

    describe('claimProcessingLease', () => {
        it('claims an unheld post that has processing state', async () => {
            await posts.savePost(withProcessing('aaaaaaaaaaaa1'));
            await expect(
                deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa1', future()),
            ).resolves.toBe(true);
        });

        it('refuses a post with no processing state, and does not create one', async () => {
            // Load-bearing, not an optimisation: the service reads a present
            // `processing` object as "processing was requested", so claiming
            // here would permanently change how a post renders.
            await posts.savePost(withProcessing('aaaaaaaaaaaa2', { processing: undefined }));
            await expect(
                deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa2', future()),
            ).resolves.toBe(false);

            const [row] = await db.query<{ processing: unknown }>(
                'select processing from posts where id = $1',
                ['aaaaaaaaaaaa2'],
            );
            expect(row.processing).toBeNull();
        });

        it('refuses while another runner holds an unexpired lease', async () => {
            await posts.savePost(withProcessing('aaaaaaaaaaaa3'));
            await deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa3', future());
            await expect(
                deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa3', future()),
            ).resolves.toBe(false);
        });

        it('claims a post whose lease has expired', async () => {
            // A runner that died mid-pass never released; expiry is the
            // backstop that stops the post being stranded.
            await posts.savePost(withProcessing('aaaaaaaaaaaa4'));
            await deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa4', future());
            await db.query(`update posts set lease_until = now() - interval '1 second'`);
            await expect(
                deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa4', future()),
            ).resolves.toBe(true);
        });

        it('refuses a post belonging to another tenant', async () => {
            // The port documents this ("the post is gone or belongs to another
            // tenant") but the Firestore binding ignores originAppId entirely.
            // This binding implements the contract.
            await posts.savePost(withProcessing('aaaaaaaaaaaa5'));
            await expect(
                deps.claimProcessingLease('other-app', 'aaaaaaaaaaaa5', future()),
            ).resolves.toBe(false);
        });

        it('grants exactly one claim under concurrency', async () => {
            // The race the lease exists to close, run for real rather than
            // argued about. A read-then-write would let several through.
            await posts.savePost(withProcessing('aaaaaaaaaaaa6'));
            const results = await Promise.all(
                Array.from({ length: 20 }, () =>
                    deps.claimProcessingLease(TENANT, 'aaaaaaaaaaaa6', future()),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
        });
    });

    describe('releaseProcessingLease', () => {
        it('clears a lease the caller owns', async () => {
            await posts.savePost(withProcessing('bbbbbbbbbbbb1'));
            const lease = future();
            await deps.claimProcessingLease(TENANT, 'bbbbbbbbbbbb1', lease);
            await deps.releaseProcessingLease(TENANT, 'bbbbbbbbbbbb1', lease);

            const [row] = await db.query<{ lease_until: unknown }>(
                'select lease_until from posts where id = $1',
                ['bbbbbbbbbbbb1'],
            );
            expect(row.lease_until).toBeNull();
        });

        it('does NOT clear a lease that has since been reclaimed by another runner', async () => {
            // The fencing token. Runner A's lease lapses, runner B claims, then
            // A finally reaches its `finally` block. An unconditional clear
            // would hand the post to a third runner while B is still working —
            // the hazard the lease closes, at the moment the system is already
            // slow enough to have caused it.
            await posts.savePost(withProcessing('bbbbbbbbbbbb2'));
            const leaseA = future();
            await deps.claimProcessingLease(TENANT, 'bbbbbbbbbbbb2', leaseA);
            await db.query(`update posts set lease_until = now() - interval '1 second'`);
            const leaseB = new Date(Date.now() + 30 * 60 * 1000);
            expect(await deps.claimProcessingLease(TENANT, 'bbbbbbbbbbbb2', leaseB)).toBe(true);

            await deps.releaseProcessingLease(TENANT, 'bbbbbbbbbbbb2', leaseA);

            const [row] = await db.query<{ lease_until: Date }>(
                'select lease_until from posts where id = $1',
                ['bbbbbbbbbbbb2'],
            );
            expect(new Date(row.lease_until).toISOString()).toBe(leaseB.toISOString());
        });

        it('is a no-op for a post that does not exist', async () => {
            await expect(
                deps.releaseProcessingLease(TENANT, 'nonexistent1', future()),
            ).resolves.toBeUndefined();
        });
    });

    describe('patchProcessingState', () => {
        it('merges without disturbing sibling stages', async () => {
            await posts.savePost(
                withProcessing('cccccccccccc1', {
                    processing: {
                        transcribe: 'pending',
                        waveform: 'pending',
                        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
                    },
                }),
            );
            await deps.patchProcessingState(TENANT, 'cccccccccccc1', { transcribe: 'ready' });

            const read = await posts.getPostById(TENANT, 'cccccccccccc1');
            expect(read?.processing?.transcribe).toBe('ready');
            expect(read?.processing?.waveform).toBe('pending');
        });

        it('stamps updatedAt on every patch', async () => {
            await posts.savePost(withProcessing('cccccccccccc2'));
            const before = (await posts.getPostById(TENANT, 'cccccccccccc2'))!.processing!.updatedAt;
            await deps.patchProcessingState(TENANT, 'cccccccccccc2', { transcribe: 'ready' });
            const after = (await posts.getPostById(TENANT, 'cccccccccccc2'))!.processing!.updatedAt;
            expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
        });

        it('does not disturb the lease column', async () => {
            await posts.savePost(withProcessing('cccccccccccc3'));
            const lease = future();
            await deps.claimProcessingLease(TENANT, 'cccccccccccc3', lease);
            await deps.patchProcessingState(TENANT, 'cccccccccccc3', { transcribe: 'ready' });

            const [row] = await db.query<{ lease_until: Date }>(
                'select lease_until from posts where id = $1',
                ['cccccccccccc3'],
            );
            expect(new Date(row.lease_until).toISOString()).toBe(lease.toISOString());
        });

        it('throws for a post that is gone', async () => {
            // Firestore's `update()` rejects on a missing document; preserved,
            // because a silent no-op would settle a stage in memory while
            // nothing was written.
            await expect(
                deps.patchProcessingState(TENANT, 'nonexistent1', { transcribe: 'ready' }),
            ).rejects.toThrow(/not found/);
        });

        it('throws for a cross-tenant patch', async () => {
            await posts.savePost(withProcessing('cccccccccccc4'));
            await expect(
                deps.patchProcessingState('other-app', 'cccccccccccc4', { transcribe: 'ready' }),
            ).rejects.toThrow(/not found/);
        });
    });

    describe('saveTranscript', () => {
        const transcript = (id: string, uri: string, text: string) => ({
            id,
            subject: { uri, cid: 'bafyreisubject' },
            transcript: { segments: [{ startMs: 0, endMs: 10, text }], text },
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
        });

        it('is last-write-wins per subject uri — now enforced by the store', async () => {
            // The port documents this; Firestore could only hope for it (its
            // read path concedes "last write wins if a post somehow has
            // multiple transcripts"). The unique index on the generated
            // subject_uri column makes it true.
            const uri = 'at://did:web:example.com/c/post1';
            await deps.saveTranscript(transcript('t000000000001', uri, 'first'));
            await deps.saveTranscript(transcript('t000000000002', uri, 'second'));

            const rows = await db.query<{ id: string }>('select id from audio_transcripts');
            expect(rows).toHaveLength(1);

            const map = await posts.getTranscriptsBySubjectUris([uri]);
            expect(map.get(uri)?.transcript.text).toBe('second');
        });

        it('keeps transcripts for different subjects side by side', async () => {
            await deps.saveTranscript(
                transcript('t000000000003', 'at://did:web:example.com/c/a', 'a'),
            );
            await deps.saveTranscript(
                transcript('t000000000004', 'at://did:web:example.com/c/b', 'b'),
            );
            const rows = await db.query('select id from audio_transcripts');
            expect(rows).toHaveLength(2);
        });
    });

    describe('newTranscriptId', () => {
        it('mints distinct, time-sortable ids', async () => {
            const ids = Array.from({ length: 5 }, () => deps.newTranscriptId());
            expect(new Set(ids).size).toBe(5);
            expect([...ids].sort()).toEqual(ids);
        });
    });
});
