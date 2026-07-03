/**
 * BlobStore is the portable interface for audio (and generic binary) storage.
 * The default Firebase Storage implementation lives in
 * `apps/core-api/src/adapters/outbound/firebase/storage-dependencies.ts`.
 * Alternative backends (S3-compatible, local filesystem for dev) can be
 * plugged in by providing an object conforming to this interface.
 *
 * URL format note: `upload` returns a provider-specific URL (for Firebase:
 * `https://storage.googleapis.com/{bucket}/{path}`). Callers treat this as
 * an opaque string. To extract the object path from a stored URL later
 * (e.g., when issuing a signed URL for the audio proxy), use
 * `extractObjectPath` — the implementation knows its own URL patterns,
 * including legacy formats it still needs to recognize.
 */
export interface BlobStore {
    /**
     * Upload a buffer to the given path. Returns the canonical URL for the
     * stored object (provider-specific format). The caller is expected to
     * persist this URL; the audio proxy later calls `extractObjectPath` to
     * derive the object path back from the URL for signed-URL issuance.
     */
    upload(buffer: Buffer, destinationPath: string, mimeType: string): Promise<string>;

    /**
     * Generate a time-limited read URL for an object path. Callers pass the
     * object path (e.g., "audio/uid/file.webm"), not a full URL.
     */
    getSignedUrl(objectPath: string, expiresMs: number): Promise<string>;

    /**
     * Download an object's raw bytes by object path. Returns null when the
     * object doesn't exist. Used by the audio-processing worker to read blob
     * bytes for transcription / denoise.
     */
    download(objectPath: string): Promise<Buffer | null>;

    /**
     * Extract the storage object path from a full provider URL. Returns
     * null if the URL doesn't match any of this provider's known patterns.
     * Implementations MAY support multiple formats (e.g., both the current
     * and a legacy URL shape) — the Firebase impl supports both
     * `storage.googleapis.com` and `firebasestorage.googleapis.com`.
     */
    extractObjectPath(url: string): string | null;
}
