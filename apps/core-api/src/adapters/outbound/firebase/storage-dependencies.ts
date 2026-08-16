import { Readable } from 'node:stream';
import { getAdminStorage } from '../../../lib/firebase-admin.js';
import type {
    BlobRange,
    BlobRead,
    BlobStore,
} from '@antiphony/core/ports/storage-dependencies';

export type { BlobStore };

/**
 * Firebase Storage-backed `BlobStore`. Handles both the current
 * `storage.googleapis.com` URL shape and the legacy
 * `firebasestorage.googleapis.com` shape that older records still reference.
 *
 * `getSignedUrl` is gone from the port (the audio proxy streams now — see
 * ports/storage-dependencies.ts), which means this binding no longer needs the
 * signing credential at all. That was the only capability here requiring more
 * than read/write on the bucket.
 */

export const firebaseBlobStore: BlobStore = {
    async upload(bytes, destinationPath, mimeType) {
        const bucket = getAdminStorage().bucket();
        const file = bucket.file(destinationPath);

        // The Admin SDK wants a Buffer. `Buffer.from(view)` COPIES rather than
        // wrapping when given a Uint8Array view, so a `subarray` cannot leak
        // its neighbours into the upload.
        await file.save(Buffer.from(bytes), { metadata: { contentType: mimeType } });

        const encodedPath = encodeURIComponent(destinationPath).replace(/%2F/g, '/');
        return `https://storage.googleapis.com/${bucket.name}/${encodedPath}`;
    },

    async openStream(objectPath: string, range?: BlobRange): Promise<BlobRead | null> {
        const file = getAdminStorage().bucket().file(objectPath);

        // Existence has to be checked up front: `createReadStream` defers the
        // 404 to an error event on the stream, which would surface as a broken
        // response mid-flight rather than as a clean null.
        const [exists] = await file.exists();
        if (!exists) return null;

        const [meta] = await file.getMetadata();
        const totalSize = Number(meta.size ?? 0);

        const start = range?.offset ?? 0;
        // GCS `end` is INCLUSIVE, unlike every other range API in this file —
        // an off-by-one here silently truncates or over-reads by one byte.
        const end =
            range?.length === undefined
                ? undefined
                : Math.min(start + range.length - 1, totalSize - 1);

        const node = file.createReadStream(
            end === undefined ? { start } : { start, end },
        );

        return {
            body: Readable.toWeb(node) as ReadableStream<Uint8Array>,
            size: rangeLength(totalSize, range),
            totalSize,
            mimeType: meta.contentType,
        };
    },

    async download(objectPath) {
        const file = getAdminStorage().bucket().file(objectPath);
        try {
            const [bytes] = await file.download();
            return new Uint8Array(bytes);
        } catch (err) {
            // 404 → object doesn't exist; surface as null. Other errors rethrow.
            if ((err as { code?: number }).code === 404) return null;
            throw err;
        }
    },

    extractObjectPath(url) {
        // Pattern 1 (current): https://storage.googleapis.com/{bucket}/{path}
        const gcsMatch = url.match(/^https:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
        if (gcsMatch) return decodeURIComponent(gcsMatch[1]);

        // Pattern 2 (legacy): https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?...
        const fbMatch = url.match(
            /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/,
        );
        if (fbMatch) return decodeURIComponent(fbMatch[1]);

        return null;
    },
};

function rangeLength(totalSize: number, range?: BlobRange): number {
    if (!range) return totalSize;
    const available = Math.max(0, totalSize - range.offset);
    return range.length === undefined ? available : Math.min(range.length, available);
}
