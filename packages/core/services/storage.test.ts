import { describe, it, expect, vi } from 'vitest';
import { makeStorageService } from './storage';
import type { BlobRead, BlobStat, BlobStore } from '../ports/storage-dependencies';

function makeMockBlobStore() {
    const store: BlobStore = {
        upload: vi.fn(),
        openStream: vi.fn(),
        download: vi.fn(),
        stat: vi.fn(),
        delete: vi.fn(),
        extractObjectPath: vi.fn(),
    };
    return store;
}

describe('makeStorageService', () => {
    it('delegates uploadFile to blob.upload with bytes, path, mimeType, and options', async () => {
        const blob = makeMockBlobStore();
        vi.mocked(blob.upload).mockResolvedValue('r2://bucket/blobs/app/cid');
        const service = makeStorageService(blob);
        const bytes = new Uint8Array([1, 2, 3]);
        const options = { cacheControl: 'public, max-age=31536000' };

        const url = await service.uploadFile(bytes, 'blobs/app/cid', 'audio/webm', options);

        expect(url).toBe('r2://bucket/blobs/app/cid');
        expect(blob.upload).toHaveBeenCalledWith(bytes, 'blobs/app/cid', 'audio/webm', options);
    });

    it('delegates openStream with optional byte range and passes through null on miss', async () => {
        const blob = makeMockBlobStore();
        const read: BlobRead = {
            body: new ReadableStream(),
            contentType: 'audio/webm',
            size: 100,
        };
        vi.mocked(blob.openStream).mockResolvedValueOnce(read).mockResolvedValueOnce(null);
        const service = makeStorageService(blob);

        expect(await service.openStream('blobs/app/cid', { start: 0, end: 49 })).toBe(read);
        expect(blob.openStream).toHaveBeenCalledWith('blobs/app/cid', { start: 0, end: 49 });
        expect(await service.openStream('blobs/app/missing')).toBeNull();
    });

    it('delegates download, stat, deleteObjects, and extractObjectPath', async () => {
        const blob = makeMockBlobStore();
        const bytes = new Uint8Array([9, 8]);
        const stat: BlobStat = { size: 2, contentType: 'audio/webm' };
        vi.mocked(blob.download).mockResolvedValue(bytes);
        vi.mocked(blob.stat).mockResolvedValue(stat);
        vi.mocked(blob.delete).mockResolvedValue(undefined);
        vi.mocked(blob.extractObjectPath).mockReturnValue('blobs/app/cid');
        const service = makeStorageService(blob);

        expect(await service.download('blobs/app/cid')).toBe(bytes);
        expect(await service.stat('blobs/app/cid')).toBe(stat);
        await service.deleteObjects(['blobs/app/cid', 'renditions/app/cid.mp3']);
        expect(blob.delete).toHaveBeenCalledWith(['blobs/app/cid', 'renditions/app/cid.mp3']);
        expect(service.extractObjectPath('https://api.antiphony.dev/blobs/app/cid')).toBe('blobs/app/cid');
    });
});
