/**
 * Blob storage paths are DERIVED from content CIDs, never stored:
 *
 *     blobs/{originAppId}/{cid}
 *
 * - Records stay portable: they carry the CID (`BlobRef.ref.$link`), and any
 *   deployment can resolve it against its own blob store.
 * - Tenancy-scoped: one origin app can never address another app's blobs.
 * - Content-addressed: identical bytes uploaded twice land on the same
 *   object (free dedup); no extension needed — the MIME type lives on the
 *   blob ref and is set as the object's Content-Type at upload.
 */

/** Sanity pattern for path segments: CIDs and app ids are URL-safe tokens. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Derive the storage object path for a blob. Returns null when either
 * segment is missing or unsafe (defense against path traversal — a CID or
 * app id must never contain `/` or `.`).
 */
export function blobObjectPath(originAppId: string, cid: string): string | null {
    if (!SAFE_SEGMENT.test(originAppId) || !SAFE_SEGMENT.test(cid)) return null;
    return `blobs/${originAppId}/${cid}`;
}
