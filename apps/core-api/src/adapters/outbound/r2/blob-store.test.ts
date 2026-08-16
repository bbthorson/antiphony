import { describe, it, expect, beforeEach } from 'vitest';
import { r2BlobStore } from './blob-store.js';
import { createFakeBucket, drain, type FakeBucket } from './testing/fake-bucket.js';
import type { BlobStore } from '@antiphony/core/ports/storage-dependencies';

const BUCKET = 'antiphony-blobs';
const PATH = 'blobs/vox-pop/bafkreiaudio';

describe('r2BlobStore', () => {
    let bucket: FakeBucket;
    let store: BlobStore;

    beforeEach(() => {
        bucket = createFakeBucket();
        store = r2BlobStore({ bucket, bucketName: BUCKET });
    });

    describe('upload', () => {
        it('stores the bytes with their content type and returns an r2:// handle', async () => {
            const url = await store.upload(new TextEncoder().encode('audio'), PATH, 'audio/webm');
            expect(url).toBe(`r2://${BUCKET}/${PATH}`);
            expect(bucket.objects.get(PATH)?.contentType).toBe('audio/webm');
        });

        it('uploads only the view, not its whole backing buffer', async () => {
            // A `subarray` view shares its buffer. Handing the buffer straight
            // to R2 would upload the neighbouring bytes too — silent
            // corruption, not an error, and invisible unless a test slices.
            const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
            const view = backing.subarray(2, 5); // [2,3,4]
            await store.upload(view, PATH, 'application/octet-stream');
            expect(Array.from(bucket.objects.get(PATH)!.bytes)).toEqual([2, 3, 4]);
        });
    });

    describe('openStream', () => {
        beforeEach(async () => {
            await store.upload(new Uint8Array([10, 20, 30, 40, 50]), PATH, 'audio/webm');
        });

        it('streams the whole object with its size and type', async () => {
            const read = await store.openStream(PATH);
            expect(read).not.toBeNull();
            expect(read!.size).toBe(5);
            expect(read!.totalSize).toBe(5);
            expect(read!.mimeType).toBe('audio/webm');
            expect(Array.from(await drain(read!.body))).toEqual([10, 20, 30, 40, 50]);
        });

        it('returns null for an object that does not exist', async () => {
            // Absence is an expected answer — a CID that was never uploaded —
            // so it must not throw.
            await expect(store.openStream('blobs/vox-pop/missing')).resolves.toBeNull();
        });

        it('reports the RANGE length as size, not the object size', async () => {
            // R2 sets `size` to the total even on a ranged get, so the binding
            // computes this. Getting it wrong yields a Content-Length that
            // disagrees with the bytes sent, which hangs clients rather than
            // failing visibly.
            const read = await store.openStream(PATH, { offset: 1, length: 2 });
            expect(read!.size).toBe(2);
            expect(read!.totalSize).toBe(5);
            expect(Array.from(await drain(read!.body))).toEqual([20, 30]);
        });

        it('clamps a range that runs past the end', async () => {
            const read = await store.openStream(PATH, { offset: 3, length: 99 });
            expect(read!.size).toBe(2);
            expect(Array.from(await drain(read!.body))).toEqual([40, 50]);
        });

        it('treats an open-ended range as "to the end"', async () => {
            const read = await store.openStream(PATH, { offset: 2 });
            expect(read!.size).toBe(3);
            expect(Array.from(await drain(read!.body))).toEqual([30, 40, 50]);
        });

        it('returns an empty read — not null — for a range starting past the end', async () => {
            // The object exists; the range is empty. Reporting null would say
            // "no such object", which is a different answer and a different
            // status code.
            const read = await store.openStream(PATH, { offset: 99 });
            expect(read).not.toBeNull();
            expect(read!.size).toBe(0);
            expect(read!.totalSize).toBe(5);
            expect(Array.from(await drain(read!.body))).toEqual([]);
        });
    });

    describe('download', () => {
        it('returns the whole object as bytes', async () => {
            await store.upload(new Uint8Array([1, 2, 3]), PATH, 'audio/webm');
            const bytes = await store.download(PATH);
            expect(Array.from(bytes!)).toEqual([1, 2, 3]);
        });

        it('returns null for a missing object', async () => {
            await expect(store.download('blobs/vox-pop/missing')).resolves.toBeNull();
        });
    });

    describe('extractObjectPath', () => {
        it('reads back its own handle', () => {
            expect(store.extractObjectPath(`r2://${BUCKET}/${PATH}`)).toBe(PATH);
        });

        it('still recognises legacy GCS URLs stored in existing records', () => {
            // A data migration moves objects; it does not rewrite the URLs
            // already inside published records. Dropping these would make
            // every pre-migration post's audio unresolvable.
            expect(
                store.extractObjectPath(
                    'https://storage.googleapis.com/antiphony-core.firebasestorage.app/blobs/vox-pop/bafkreiaudio',
                ),
            ).toBe(PATH);
            expect(
                store.extractObjectPath(
                    'https://firebasestorage.googleapis.com/v0/b/antiphony-core.firebasestorage.app/o/blobs%2Fvox-pop%2Fbafkreiaudio?alt=media',
                ),
            ).toBe(PATH);
        });

        it('rejects anything else', () => {
            expect(store.extractObjectPath('https://evil.example/blobs/x/y')).toBeNull();
            expect(store.extractObjectPath('r2://')).toBeNull();
            expect(store.extractObjectPath('not a url')).toBeNull();
        });
    });
});
