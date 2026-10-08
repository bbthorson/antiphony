import type { BlobRange, BlobRead, BlobStat, BlobStore, BlobUploadOptions } from '../ports/storage-dependencies';

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
    uploadFile(bytes: Uint8Array, destinationPath: string, mimeType: string, options?: BlobUploadOptions): Promise<string>;

    /** Open an object for streaming, optionally a byte range. Null when absent. */
    openStream(objectPath: string, range?: BlobRange): Promise<BlobRead | null>;

    /** Read an object's full bytes, or null when absent. */
    download(objectPath: string): Promise<Uint8Array | null>;

    /** An object's size, type and metadata without its bytes, or null when absent. */
    stat(objectPath: string): Promise<BlobStat | null>;

    /** Extract the storage object path from a full URL, or null if unrecognised. */
    extractObjectPath(url: string): string | null;
}

/**
 * Factory that builds a StorageService around a BlobStore binding. Kept as a
 * factory (not a class) to preserve the const-object call shape callers use.
 */
export function makeStorageService(blob: BlobStore): StorageService {
    return {
        uploadFile(bytes, destinationPath, mimeType, options) {
            return blob.upload(bytes, destinationPath, mimeType, options);
        },
        openStream(objectPath, range) {
            return blob.openStream(objectPath, range);
        },
        download(objectPath) {
            return blob.download(objectPath);
        },
        stat(objectPath) {
            return blob.stat(objectPath);
        },
        extractObjectPath(url) {
            return blob.extractObjectPath(url);
        },
    };
}
