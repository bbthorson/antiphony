import { getAdminStorage } from '../../../lib/firebase-admin.js';
import type { BlobStore } from '@antiphony/core/ports/storage-dependencies';

export type { BlobStore };

/**
 * Firebase Storage-backed `BlobStore` for core-api. Parity with
 * `apps/web/src/services/storage-dependencies.ts` — handles both the
 * current `storage.googleapis.com` URL shape and the legacy
 * `firebasestorage.googleapis.com` shape that older Firestore records
 * may still reference.
 */

export const firebaseBlobStore: BlobStore = {
    async upload(buffer, destinationPath, mimeType) {
        const bucket = getAdminStorage().bucket();
        const file = bucket.file(destinationPath);

        await file.save(buffer, {
            metadata: { contentType: mimeType },
        });

        const bucketName = bucket.name;
        const encodedPath = encodeURIComponent(destinationPath).replace(/%2F/g, '/');
        return `https://storage.googleapis.com/${bucketName}/${encodedPath}`;
    },

    async getSignedUrl(objectPath, expiresMs) {
        const bucket = getAdminStorage().bucket();
        const file = bucket.file(objectPath);
        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + expiresMs,
        });
        return url;
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
