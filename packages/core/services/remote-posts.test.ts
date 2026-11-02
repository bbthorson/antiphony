import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranscriptEnrichmentRecord } from 'shared/types/audio';
import type { ResolvedProcessing } from 'shared/types/processing';
import type { PublicRepoPort, RepoResult, FetchedRecord, FetchedBlob } from '../ports/public-repo';
import type { RemotePostDependencies, RemotePostRow, RemoteCheckOutcome } from '../ports/remote-posts-dependencies';
import type { RemoteNotifierPort, RemotePostEvent } from '../ports/remote-notifier';
import type { ScopedSpaceKey } from 'shared/types/spaces';
import {
    RemotePostService,
    parseRemotePostUri,
    parseRemoteSpaceUri,
    sniffAudioMime,
    REMOTE_GONE_CONFIRM_MS,
    REMOTE_UNAVAILABLE_AFTER_MS,
} from './remote-posts';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const URI = `at://${DID}/dev.antiphony.audio.post/3kremote00001`;
const TENANT = 'vox-pop';

/** A Bardcast table's group DID, and a player's record in its campaign space (Phase B). */
const GROUP = 'did:plc:group0000000000000000000';
const SPACE = { authority: GROUP, type: 'game.bardcast.space.campaign', skey: 'thornwood' };
const SPACE_URI = `at://${GROUP}/space/${SPACE.type}/${SPACE.skey}/${DID}/dev.antiphony.audio.post/3kspace000001`;

/** Stand-in hashes: the real ones are DAG-CBOR and raw sha2-256 (core-api lib/cid.ts). */
const recordCid = (value: unknown) => `bafyrec-${JSON.stringify(value).length}-${JSON.stringify(value).slice(-12)}`;
const bytesCid = (bytes: Uint8Array) => `bafyblob-${Array.from(bytes).join('.')}`;

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]); // ....ftypmp42

function audioRecord(over: Record<string, unknown> = {}, bytes = MP4) {
    return {
        $type: 'dev.antiphony.audio.post',
        text: 'what did you hear?',
        embed: {
            $type: 'dev.antiphony.embed.audio',
            audio: { $type: 'blob', ref: { $link: bytesCid(bytes) }, mimeType: 'audio/mp4', size: bytes.length },
            durationMs: 1200,
        },
        createdAt: '2026-11-02T10:00:00.000Z',
        ...over,
    };
}

function fakeRepo() {
    const records = new Map<string, RepoResult<FetchedRecord>>();
    const blobs = new Map<string, RepoResult<FetchedBlob>>();
    const repo: PublicRepoPort = {
        getRecord: vi.fn(async (ref) => records.get(`at://${ref.did}/${ref.collection}/${ref.rkey}`) ?? { ok: false, kind: 'gone', reason: 'RecordNotFound' }),
        getBlob: vi.fn(async (_did, cid) => blobs.get(cid) ?? { ok: false, kind: 'gone', reason: 'BlobNotFound' }),
    };
    const publish = (uri: string, value: unknown, bytes = MP4) => {
        records.set(uri, { ok: true, value: { cid: recordCid(value), value } });
        blobs.set(bytesCid(bytes), { ok: true, value: { bytes } });
        return recordCid(value);
    };
    return { repo, records, blobs, publish };
}

function fakeDeps(clock: { now: Date }) {
    const rows = new Map<string, RemotePostRow>();
    const ledger = new Map<string, { deletedAt: Date; reason: 'tenant' | 'gone' }>();
    const stored = new Map<string, { space: ScopedSpaceKey | null }>();
    /** Blobs a verified public record references, by `${tenant} ${cid}`. */
    const publicRefs = new Set<string>();
    const madePublic: string[] = [];
    const transcripts = new Map<string, TranscriptEnrichmentRecord>();
    const key = (o: string, u: string) => `${o} ${u}`;
    const deps: RemotePostDependencies = {
        async getRemotePost(o, u) {
            const r = rows.get(key(o, u));
            return r ? structuredClone(r) : null;
        },
        async saveRemotePost(write) {
            const prev = rows.get(key(write.originAppId, write.uri));
            rows.set(key(write.originAppId, write.uri), {
                ...write,
                registeredAt: prev?.registeredAt ?? clock.now,
                checkedAt: clock.now,
                goneAt: null,
                unreachableSince: null,
            });
            ledger.delete(key(write.originAppId, write.uri));
        },
        async getDeletedRemotePost(o, u) {
            return ledger.get(key(o, u)) ?? null;
        },
        async deleteRemotePost(o, u, reason) {
            if (!rows.delete(key(o, u))) return false;
            ledger.set(key(o, u), { deletedAt: clock.now, reason });
            return true;
        },
        async listThread(o, root, { limit }) {
            const items = [...rows.values()].filter((r) => r.originAppId === o && r.record.reply?.root.uri === root);
            return { items: items.slice(0, limit), nextCursor: null };
        },
        async mergeProcessing(o, u, resolved: ResolvedProcessing) {
            const r = rows.get(key(o, u))!;
            r.processing = { ...r.processing, ...resolved, updatedAt: clock.now };
        },
        async listForSweep(limit) {
            return [...rows.values()]
                .filter((r) => r.verified === 'fetched')
                .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())
                .slice(0, limit)
                .map((r) => ({ originAppId: r.originAppId, uri: r.uri, cid: r.cid, goneAt: r.goneAt, unreachableSince: r.unreachableSince }));
        },
        async recordCheck(o, u, outcome: RemoteCheckOutcome) {
            const r = rows.get(key(o, u))!;
            r.checkedAt = clock.now;
            if (outcome === 'present') {
                r.goneAt = null;
                r.unreachableSince = null;
            } else if (outcome === 'gone') {
                r.goneAt ??= clock.now;
                r.unreachableSince = null;
            } else {
                r.unreachableSince ??= clock.now;
                r.goneAt = null;
            }
        },
        async getTranscripts(_o, uris) {
            return new Map(uris.flatMap((u) => (transcripts.has(u) ? [[u, transcripts.get(u)!] as const] : [])));
        },
        async getStoredBlob(o, cid) {
            return stored.get(key(o, cid)) ?? null;
        },
        async storeBlob(o, cid) {
            const existing = stored.get(key(o, cid));
            if (existing) return existing;
            stored.set(key(o, cid), { space: null });
            return { space: null };
        },
        async hasVerifiedPublicReference(o, cid) {
            return (
                publicRefs.has(key(o, cid)) ||
                [...rows.values()].some((r) => r.originAppId === o && r.blob.cid === cid && r.verified === 'fetched' && !r.space)
            );
        },
        async makeBlobPublic(o, cid) {
            const s = stored.get(key(o, cid));
            if (s) s.space = null;
            madePublic.push(cid);
        },
        cidForBytes: async (bytes) => bytesCid(bytes),
        cidForRepoRecord: async (value) => recordCid(value),
        resolveAudioUrl: async (o, cid, isPrivate) => (isPrivate ? `https://api.example/audio/${cid}?sig=x` : `https://api.example/audio/${o}/${cid}`),
        now: () => clock.now,
    };
    return { deps, rows, ledger, stored, transcripts, publicRefs, madePublic };
}

describe('parseRemotePostUri', () => {
    it('accepts a plain audio post URI', () => {
        expect(parseRemotePostUri(URI)).toEqual({
            did: DID,
            collection: 'dev.antiphony.audio.post',
            rkey: '3kremote00001',
            space: null,
        });
    });

    it("accepts a space record, with the author segment as the record's repo", () => {
        expect(parseRemotePostUri(SPACE_URI)).toEqual({
            did: DID,
            collection: 'dev.antiphony.audio.post',
            rkey: '3kspace000001',
            space: SPACE,
        });
    });

    it.each([
        ['a space record whose author is not a DID', `at://${GROUP}/space/${SPACE.type}/c1/alice/dev.antiphony.audio.post/3k`],
        ['a space record with a bad type', `at://${GROUP}/space/campaign/c1/${DID}/dev.antiphony.audio.post/3k`],
        ['a space record in another collection', `at://${GROUP}/space/${SPACE.type}/c1/${DID}/app.bsky.feed.post/3k`],
        ['another collection', `at://${DID}/app.bsky.feed.post/3k`],
        ['a handle authority', 'at://alice.example/dev.antiphony.audio.post/3k'],
        ['not an at URI', 'https://example.com/x'],
    ])('refuses %s', (_label, uri) => {
        expect(() => parseRemotePostUri(uri)).toThrow(expect.objectContaining({ status: 400, code: 'REMOTE_URI_UNSUPPORTED' }));
    });
});

describe('parseRemoteSpaceUri', () => {
    it('parses at://{authority}/space/{type}/{skey}', () => {
        expect(parseRemoteSpaceUri(`at://${GROUP}/space/${SPACE.type}/${SPACE.skey}`)).toEqual(SPACE);
    });

    it.each([
        `at://${GROUP}/space/${SPACE.type}`,
        `at://alice.example/space/${SPACE.type}/t`,
        `at://${GROUP}/space/notannsid/t`,
        `at://${GROUP}/notspace/${SPACE.type}/t`,
    ])('refuses %s', (uri) => {
        expect(() => parseRemoteSpaceUri(uri)).toThrow(expect.objectContaining({ status: 400 }));
    });
});

describe('sniffAudioMime', () => {
    const bytes = (...xs: (number | string)[]) =>
        new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

    it.each([
        ['audio/mp4', bytes(0, 0, 0, 0x18, 'ftypM4A ')],
        ['audio/webm', bytes(0x1a, 0x45, 0xdf, 0xa3)],
        ['audio/ogg', bytes('OggS')],
        ['audio/wav', bytes('RIFF', 0, 0, 0, 0, 'WAVE')],
        ['audio/mpeg', bytes('ID3', 4)],
        ['audio/mpeg', bytes(0xff, 0xfb)],
    ])('recognises %s', (mime, b) => expect(sniffAudioMime(b)).toBe(mime));

    it('refuses anything else, whatever the record claims', () => {
        expect(sniffAudioMime(bytes('<html>'))).toBeNull();
        expect(sniffAudioMime(new Uint8Array())).toBeNull();
    });
});

describe('RemotePostService', () => {
    let clock: { now: Date };
    let f: ReturnType<typeof fakeDeps>;
    let r: ReturnType<typeof fakeRepo>;
    let events: RemotePostEvent[];
    let service: RemotePostService;
    const quietLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    beforeEach(() => {
        clock = { now: new Date('2026-11-02T12:00:00.000Z') };
        f = fakeDeps(clock);
        r = fakeRepo();
        events = [];
        const notifier: RemoteNotifierPort = { notifyRemote: async (e) => void events.push(e) };
        service = new RemotePostService(f.deps, r.repo, notifier, quietLogger);
    });

    describe('register', () => {
        it('reads the record from its repo, copies the blob, and indexes it', async () => {
            const cid = r.publish(URI, audioRecord());
            const result = await service.register(TENANT, { uri: URI, cid });

            expect(result.outcome).toBe('created');
            expect(result.dispatch).toBe(false);
            expect(result.row).toMatchObject({ uri: URI, cid, repoDid: DID, rkey: '3kremote00001', blobPrivate: false });
            expect(result.row.blob).toEqual({ cid: bytesCid(MP4), mimeType: 'audio/mp4', size: MP4.length });
            expect(f.stored.has(`${TENANT} ${bytesCid(MP4)}`)).toBe(true);
        });

        it('dispatches when a stage is requested', async () => {
            const cid = r.publish(URI, audioRecord());
            const result = await service.register(TENANT, { uri: URI, cid, processing: { transcribe: 'pending' } });
            expect(result.dispatch).toBe(true);
            expect(result.row.processing).toMatchObject({ transcribe: 'pending' });
        });

        it('skips the download when the tenant already stores those bytes (upload, then publish)', async () => {
            const cid = r.publish(URI, audioRecord());
            await f.deps.storeBlob(TENANT, bytesCid(MP4), MP4, 'audio/mp4');
            await service.register(TENANT, { uri: URI, cid });
            expect(r.repo.getBlob).not.toHaveBeenCalled();
        });

        it('is a no-op for a repeat, and fetches nothing', async () => {
            const cid = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid });
            vi.mocked(r.repo.getRecord).mockClear();
            const again = await service.register(TENANT, { uri: URI, cid });
            expect(again.outcome).toBe('unchanged');
            expect(r.repo.getRecord).not.toHaveBeenCalled();
        });

        it('refuses a CID that is not the record’s current one (409)', async () => {
            r.publish(URI, audioRecord());
            await expect(service.register(TENANT, { uri: URI, cid: 'bafystale' })).rejects.toMatchObject({
                status: 409,
                code: 'REMOTE_CID_MISMATCH',
            });
        });

        it('refuses a repo that reports a CID its record does not hash to (422)', async () => {
            const value = audioRecord();
            r.records.set(URI, { ok: true, value: { cid: 'bafylie', value } });
            await expect(service.register(TENANT, { uri: URI, cid: 'bafylie' })).rejects.toMatchObject({
                status: 422,
                code: 'REMOTE_RECORD_INVALID',
            });
        });

        it('refuses a record that is not an audio post (422)', async () => {
            const cid = r.publish(URI, audioRecord({ embed: undefined }));
            await expect(service.register(TENANT, { uri: URI, cid })).rejects.toMatchObject({ status: 422 });
        });

        it('refuses bytes that do not hash to the blob ref, or are not audio (422)', async () => {
            const value = audioRecord();
            const cid = r.publish(URI, value);
            r.blobs.set(bytesCid(MP4), { ok: true, value: { bytes: new Uint8Array([1, 2, 3]) } });
            await expect(service.register(TENANT, { uri: URI, cid })).rejects.toMatchObject({ status: 422 });

            const html = new Uint8Array([0x3c, 0x68, 0x74]);
            const other = `at://${DID}/dev.antiphony.audio.post/3kremote00002`;
            const cid2 = r.publish(other, audioRecord({}, html), html);
            await expect(service.register(TENANT, { uri: other, cid: cid2 })).rejects.toMatchObject({
                status: 422,
                details: { reason: 'blob is not audio Antiphony serves' },
            });
        });

        it('answers 404 for a record the repo says is gone, and 503 when the repo is unreachable', async () => {
            await expect(service.register(TENANT, { uri: URI, cid: 'bafyx' })).rejects.toMatchObject({
                status: 404,
                code: 'REMOTE_RECORD_NOT_FOUND',
            });
            r.records.set(URI, { ok: false, kind: 'unreachable', reason: 'timeout' });
            await expect(service.register(TENANT, { uri: URI, cid: 'bafyx' })).rejects.toMatchObject({
                status: 503,
                code: 'REMOTE_REPO_UNREACHABLE',
            });
        });

        it('turns private bytes public on a verified public record, after its repo serves them (§7)', async () => {
            const cid = r.publish(URI, audioRecord());
            f.stored.set(`${TENANT} ${bytesCid(MP4)}`, { space: SPACE });

            const { row } = await service.register(TENANT, { uri: URI, cid, bytesFrom: 'upload' });

            // Downloaded and checked even with bytesFrom "upload": a public record
            // naming a CID proves nothing until its repo has those bytes.
            expect(r.repo.getBlob).toHaveBeenCalledWith(DID, bytesCid(MP4), expect.any(Number));
            expect(f.madePublic).toEqual([bytesCid(MP4)]);
            expect(row.blobPrivate).toBe(false);
        });

        it("leaves private bytes private when the public record's repo doesn't serve them", async () => {
            const cid = r.publish(URI, audioRecord());
            r.blobs.clear();
            f.stored.set(`${TENANT} ${bytesCid(MP4)}`, { space: SPACE });

            await expect(service.register(TENANT, { uri: URI, cid })).rejects.toMatchObject({
                status: 422,
                code: 'REMOTE_RECORD_INVALID',
            });
            expect(f.madePublic).toEqual([]);
        });

        it('with bytesFrom "upload", refuses a repo record whose bytes were never uploaded', async () => {
            const cid = r.publish(URI, audioRecord());
            await expect(service.register(TENANT, { uri: URI, cid, bytesFrom: 'upload' })).rejects.toMatchObject({
                status: 422,
                code: 'REMOTE_RECORD_INVALID',
            });
            expect(r.repo.getBlob).not.toHaveBeenCalled();
        });

        it('refuses a record body for a repo record, which Antiphony reads itself (400)', async () => {
            const cid = r.publish(URI, audioRecord());
            await expect(service.register(TENANT, { uri: URI, cid, record: audioRecord() })).rejects.toMatchObject({
                status: 400,
                code: 'REMOTE_REQUEST_INVALID',
            });
        });

        it('takes an edit: new audio re-requests every stage that had been requested', async () => {
            const cid1 = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid: cid1, processing: { transcribe: 'pending', waveform: 'pending' } });
            f.rows.get(`${TENANT} ${URI}`)!.processing = { transcribe: 'ready', waveform: 'ready', updatedAt: clock.now };

            const newBytes = new Uint8Array([...MP4, 7]);
            const cid2 = r.publish(URI, audioRecord({ text: 'edited' }, newBytes), newBytes);
            const result = await service.register(TENANT, { uri: URI, cid: cid2 });

            expect(result.outcome).toBe('updated');
            expect(result.row.processing).toMatchObject({ transcribe: 'pending', waveform: 'pending' });
            expect(result.dispatch).toBe(true);
        });
    });

    describe('register: a pushed space record (Phase B)', () => {
        const uploaded = (space: ScopedSpaceKey | null = SPACE) => f.stored.set(`${TENANT} ${bytesCid(MP4)}`, { space });
        const push = (over: Partial<Parameters<RemotePostService['register']>[1]> = {}) => {
            const record = audioRecord();
            return service.register(TENANT, { uri: SPACE_URI, cid: recordCid(record), record, ...over });
        };

        it('indexes a record whose body hashes to its CID and whose bytes were uploaded for its space', async () => {
            uploaded();
            const { row, outcome } = await push();

            expect(outcome).toBe('created');
            expect(row).toMatchObject({ repoDid: DID, space: SPACE, verified: 'pushed', blobPrivate: true });
            // Antiphony can't read the space: nothing is fetched.
            expect(r.repo.getRecord).not.toHaveBeenCalled();
            expect(r.repo.getBlob).not.toHaveBeenCalled();

            const [view] = await service.hydrate(TENANT, [row]);
            expect(view).toMatchObject({ authorDid: DID, space: SPACE, verified: 'pushed', deletionCheck: 'tenant' });
            expect(view.embed?.url).toContain('?sig=');
        });

        it('defaults to bytesFrom "upload", and refuses "fetch" until Antiphony can read spaces (400)', async () => {
            uploaded();
            await expect(push({ bytesFrom: 'fetch' })).rejects.toMatchObject({ status: 400, code: 'REMOTE_URI_UNSUPPORTED' });
        });

        it('requires the record body (400)', async () => {
            await expect(service.register(TENANT, { uri: SPACE_URI, cid: 'bafyx' })).rejects.toMatchObject({
                status: 400,
                code: 'REMOTE_REQUEST_INVALID',
            });
        });

        it('refuses a body that does not hash to the CID, or is not an audio post (422)', async () => {
            uploaded();
            await expect(push({ cid: 'bafyother' })).rejects.toMatchObject({ status: 422, code: 'REMOTE_RECORD_INVALID' });
            const notAudio = { $type: 'dev.antiphony.audio.post', text: 'hi', createdAt: '2026-11-02T10:00:00.000Z' };
            await expect(push({ record: notAudio, cid: recordCid(notAudio) })).rejects.toMatchObject({
                status: 422,
                code: 'REMOTE_RECORD_INVALID',
            });
        });

        it('refuses audio this tenant never uploaded (422)', async () => {
            await expect(push()).rejects.toMatchObject({ status: 422, code: 'REMOTE_RECORD_INVALID' });
        });

        it("refuses audio another tenant uploaded: blobs are per tenant", async () => {
            f.stored.set(`bardcast ${bytesCid(MP4)}`, { space: SPACE });
            await expect(push()).rejects.toMatchObject({ status: 422 });
        });

        it('refuses audio stored private for another space (409)', async () => {
            uploaded({ ...SPACE, skey: 'elsewhere' });
            await expect(push()).rejects.toMatchObject({ status: 409, code: 'REMOTE_BLOB_SPACE_MISMATCH' });
            uploaded({ type: SPACE.type, skey: SPACE.skey });
            await expect(push()).rejects.toMatchObject({ status: 409, code: 'REMOTE_BLOB_SPACE_MISMATCH' });
        });

        it('refuses audio stored public that no verified public record references (409)', async () => {
            uploaded(null);
            await expect(push()).rejects.toMatchObject({ status: 409, code: 'REMOTE_BLOB_SPACE_MISMATCH' });
        });

        it('accepts public audio a verified public record references, and still plays it signed', async () => {
            uploaded(null);
            f.publicRefs.add(`${TENANT} ${bytesCid(MP4)}`);
            const { row } = await push();
            expect(row.blobPrivate).toBe(true);
            const [view] = await service.hydrate(TENANT, [row]);
            expect(view.embed?.url).toContain('?sig=');
        });

        it('never turns a blob public', async () => {
            uploaded();
            await push();
            expect(f.madePublic).toEqual([]);
            expect(f.stored.get(`${TENANT} ${bytesCid(MP4)}`)).toEqual({ space: SPACE });
        });

        it('is a no-op for a repeat, and takes an edit with new audio', async () => {
            uploaded();
            await push({ processing: { transcribe: 'pending' } });
            await expect(push()).resolves.toMatchObject({ outcome: 'unchanged' });

            const newBytes = new Uint8Array([...MP4, 7]);
            f.stored.set(`${TENANT} ${bytesCid(newBytes)}`, { space: SPACE });
            const edited = audioRecord({ text: 'edited' }, newBytes);
            const result = await push({ record: edited, cid: recordCid(edited) });
            expect(result.outcome).toBe('updated');
            expect(result.row.blob.cid).toBe(bytesCid(newBytes));
            expect(result.row.processing).toMatchObject({ transcribe: 'pending' });
        });

        it('turns public when a verified public record with the same audio is registered after it', async () => {
            uploaded();
            await push();
            const cid = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid });
            expect(f.madePublic).toEqual([bytesCid(MP4)]);
            // The space record still plays signed.
            expect(f.rows.get(`${TENANT} ${SPACE_URI}`)!.blobPrivate).toBe(true);
        });

        it('is skipped by the sweep: the tenant DELETE is its only deletion signal', async () => {
            uploaded();
            await push();
            const result = await service.sweep(10);
            expect(result.checked).toBe(0);
            expect(r.repo.getRecord).not.toHaveBeenCalled();
            await expect(service.delete(TENANT, SPACE_URI)).resolves.toBe(true);
        });
    });

    describe('reads', () => {
        it('answers 404 for an unregistered URI and 410 for a removed one', async () => {
            await expect(service.get(TENANT, URI)).rejects.toMatchObject({ status: 404, code: 'REMOTE_POST_NOT_FOUND' });
            const cid = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid });
            await expect(service.delete(TENANT, URI)).resolves.toBe(true);
            await expect(service.delete(TENANT, URI)).resolves.toBe(false);
            await expect(service.get(TENANT, URI)).rejects.toMatchObject({ status: 410, code: 'REMOTE_POST_DELETED' });
        });

        it("keeps tenants apart: another tenant's registration is not ours", async () => {
            const cid = r.publish(URI, audioRecord());
            await service.register('bardcast', { uri: URI, cid });
            await expect(service.get(TENANT, URI)).rejects.toMatchObject({ status: 404 });
        });

        it('hydrates a view with a stable URL, the transcript, and the processing status', async () => {
            const cid = r.publish(URI, audioRecord({ labels: { values: [{ val: 'nudity' }] } }));
            await service.register(TENANT, { uri: URI, cid, processing: { transcribe: 'pending' } });
            f.transcripts.set(URI, {
                id: 't1',
                subject: { uri: URI, cid },
                transcript: { segments: [], text: 'hello' },
                createdAt: clock.now,
            });
            const [view] = await service.hydrate(TENANT, [await service.get(TENANT, URI)]);

            expect(view).toMatchObject({
                uri: URI,
                cid,
                kind: 'prompt',
                authorDid: DID,
                available: true,
                record: { text: 'what did you hear?', selfLabels: ['nudity'] },
                embed: {
                    url: `https://api.example/audio/${TENANT}/${bytesCid(MP4)}`,
                    durationMs: 1200,
                    transcript: { text: 'hello' },
                    processing: { transcribe: 'pending' },
                },
            });
        });

        it('returns the registered replies under a root, with the root on the first page', async () => {
            const rootCid = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid: rootCid });
            const replyUri = `at://did:plc:zyxwvutsrqponmlkjihgfedc/dev.antiphony.audio.post/3kreply000001`;
            const reply = audioRecord({ reply: { root: { uri: URI, cid: rootCid }, parent: { uri: URI, cid: rootCid } } });
            const replyCid = r.publish(replyUri, reply);
            await service.register(TENANT, { uri: replyUri, cid: replyCid });

            const page = await service.thread(TENANT, URI, { limit: 50 });
            expect(page.root?.uri).toBe(URI);
            expect(page.replies.map((x) => x.uri)).toEqual([replyUri]);
            expect((await service.thread(TENANT, URI, { limit: 50, cursor: 'x' })).root).toBeNull();
        });
    });

    describe('sweep', () => {
        async function registered() {
            const cid = r.publish(URI, audioRecord());
            await service.register(TENANT, { uri: URI, cid });
            return cid;
        }

        it('notes a record that is still there', async () => {
            await registered();
            clock.now = new Date(clock.now.getTime() + 60_000);
            expect(await service.sweep(10)).toMatchObject({ checked: 1, removed: 0, changed: 0 });
            expect(f.rows.get(`${TENANT} ${URI}`)!.checkedAt).toEqual(clock.now);
        });

        it('removes a post only after two "gone" reads at least an hour apart, and says so', async () => {
            await registered();
            r.records.delete(URI);

            await service.sweep(10);
            expect(f.rows.has(`${TENANT} ${URI}`)).toBe(true);

            clock.now = new Date(clock.now.getTime() + REMOTE_GONE_CONFIRM_MS - 1);
            await service.sweep(10);
            expect(f.rows.has(`${TENANT} ${URI}`)).toBe(true);

            clock.now = new Date(clock.now.getTime() + 1);
            expect(await service.sweep(10)).toMatchObject({ removed: 1 });
            expect(f.ledger.get(`${TENANT} ${URI}`)?.reason).toBe('gone');
            expect(events).toEqual([{ type: 'remote.gone', originAppId: TENANT, uri: URI, occurredAt: clock.now.toISOString() }]);
        });

        it('restarts the count when a "gone" read is followed by an unreachable one', async () => {
            await registered();
            r.records.delete(URI);
            await service.sweep(10);
            r.records.set(URI, { ok: false, kind: 'unreachable', reason: '502' });
            clock.now = new Date(clock.now.getTime() + REMOTE_GONE_CONFIRM_MS);
            await service.sweep(10);
            r.records.delete(URI);
            clock.now = new Date(clock.now.getTime() + REMOTE_GONE_CONFIRM_MS);
            await service.sweep(10);
            expect(f.rows.has(`${TENANT} ${URI}`)).toBe(true);
        });

        it('never removes an unreachable post, but stops serving it after 30 days', async () => {
            await registered();
            r.records.set(URI, { ok: false, kind: 'unreachable', reason: 'timeout' });
            await service.sweep(10);
            clock.now = new Date(clock.now.getTime() + REMOTE_UNAVAILABLE_AFTER_MS);
            await service.sweep(10);

            const row = await service.get(TENANT, URI);
            const [view] = await service.hydrate(TENANT, [row]);
            expect(view.available).toBe(false);
            expect(view.embed).toBeUndefined();
            expect(quietLogger.warn).toHaveBeenCalled();
        });

        it('takes an edit, and announces it', async () => {
            await registered();
            const cid2 = r.publish(URI, audioRecord({ text: 'edited' }));
            expect(await service.sweep(10)).toMatchObject({ changed: 1 });
            expect((await service.get(TENANT, URI)).cid).toBe(cid2);
            expect(events).toEqual([expect.objectContaining({ type: 'remote.changed', cid: cid2 })]);
        });

        it('removes a post whose record was edited into something that is not an audio post', async () => {
            await registered();
            r.publish(URI, audioRecord({ embed: undefined }));
            expect(await service.sweep(10)).toMatchObject({ removed: 1 });
        });
    });
});
