import type { BlobRange, BlobRead, BlobStore } from '../ports/storage-dependencies';

/**
 * Public shape of the storage service — a const-object API rather than a class,
 * so callers use it as `StorageService.uploadFile(...)`.
 *
 * `getSignedUrl` is gone: the audio proxy streams bytes now instead of
 * redirecting to a time-limited URL, and no backend on the roadmap can mint one
 * from a binding. See ports/storage-dependencies.ts for the reasoning.
 */
export interface StorageService {
    /**
     * Upload bytes to the configured blob store. Returns the canonical URL for
     * the stored object (provider-specific) — callers persist it as-is.
     */
    uploadFile(bytes: Uint8Array, destinationPath: string, mimeType: string): Promise<string>;

    /** Open an object for streaming, optionally a byte range. Null when absent. */
    openStream(objectPath: string, range?: BlobRange): Promise<BlobRead | null>;

    /** Read an object's full bytes, or null when absent. */
    download(objectPath: string): Promise<Uint8Array | null>;

    /** Extract the storage object path from a full URL, or null if unrecognised. */
    extractObjectPath(url: string): string | null;
}

/**
 * Factory that builds a StorageService around a BlobStore binding. Kept as a
 * factory (not a class) to preserve the const-object call shape callers use.
 */
export function makeStorageService(blob: BlobStore): StorageService {
    return {
        uploadFile(bytes, destinationPath, mimeType) {
            return blob.upload(bytes, destinationPath, mimeType);
        },
        openStream(objectPath, range) {
            return blob.openStream(objectPath, range);
        },
        download(objectPath) {
            return blob.download(objectPath);
        },
        extractObjectPath(url) {
            return blob.extractObjectPath(url);
        },
    };
}
