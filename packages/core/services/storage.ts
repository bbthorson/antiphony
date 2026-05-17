import type { BlobStore } from '../ports/storage-dependencies';

/**
 * Default signed-URL expiry: 1 hour. Callers can override per-call.
 */
const SIGNED_URL_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Public shape of the storage service. Mirrors the const-object API the
 * apps/web consumers have always used (so the migration is a transparent
 * move from their perspective).
 */
export interface StorageService {
    /**
     * Upload a file to the configured blob store. Returns the canonical URL
     * for the stored object (provider-specific format) — callers persist
     * this URL as-is.
     */
    uploadFile(buffer: Buffer, destinationPath: string, mimeType: string): Promise<string>;

    /**
     * Generate a time-limited signed URL for a storage object path.
     * Defaults to 1-hour expiry if `expiresMs` is omitted.
     */
    getSignedUrl(objectPath: string, expiresMs?: number): Promise<string>;

    /** Extract the storage object path from a full URL, or null if unrecognized. */
    extractObjectPath(url: string): string | null;
}

/**
 * Factory that builds a StorageService around a BlobStore binding. Kept as
 * a factory (not a class) to preserve the const-object call shape that
 * apps/web consumers already use (`StorageService.uploadFile(...)`).
 */
export function makeStorageService(blob: BlobStore): StorageService {
    return {
        uploadFile(buffer, destinationPath, mimeType) {
            return blob.upload(buffer, destinationPath, mimeType);
        },
        getSignedUrl(objectPath, expiresMs = SIGNED_URL_EXPIRY_MS) {
            return blob.getSignedUrl(objectPath, expiresMs);
        },
        extractObjectPath(url) {
            return blob.extractObjectPath(url);
        },
    };
}
