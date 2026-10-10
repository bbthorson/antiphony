import type {
    BlobRange,
    BlobRead,
    BlobStat,
    BlobStore,
} from '@antiphony/core/ports/storage-dependencies';
import type { R2BucketLike } from './bucket.js';

/**
 * R2-backed `BlobStore`.
 *
 * Every method here is one binding call with no credential in sight. R2 access
 * from a Worker is authorised by the binding itself, so there is no service
 * account to mount, no signing, and no key to rotate. There is no signed-URL
 * method because the audio proxy streams instead (ports/storage-dependencies.ts).
 *
 * ## URL shape
 *
 * `upload` returns `r2://{bucket}/{path}`.
 *
 * A pseudo-scheme rather than a public https URL, deliberately. The stored
 * value is an OPAQUE handle that only `extractObjectPath` reads back — nothing
 * fetches it. A real-looking https URL that 403s without a signature would be
 * actively misleading; an unfetchable string that does not look fetchable is
 * more honest.
 *
 * It also keeps the object path recoverable without knowing a public hostname,
 * which the Worker may not have configured.
 */

export interface R2BlobStoreConfig {
    bucket: R2BucketLike;
    /** Bucket name, used only to build and parse the `r2://` handle. */
    bucketName: string;
}

/** `r2://{bucket}/{path}` — anchored so a partial match cannot pass. */
const R2_URL = /^r2:\/\/([^/]+)\/(.+)$/;

/**
 * Google Cloud Storage URL shapes an earlier storage backend returned from
 * `upload`.
 *
 * Still recognised because callers may hold URLs in these shapes and pass them
 * to the audio proxy (`GET /api/v1/audio?url=…`); `extractObjectPath` turns them
 * back into an object path, which the proxy then resolves in R2 like any other.
 * Removing them would turn those callers' audio into 400s, so they stay until
 * no caller sends them.
 */
const LEGACY_GCS = /^https:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/;
const LEGACY_FIREBASE = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/;

export function r2BlobStore(config: R2BlobStoreConfig): BlobStore {
    const { bucket, bucketName } = config;

    return {
        async upload(bytes, destinationPath, mimeType, options) {
            await bucket.put(destinationPath, toArrayBuffer(bytes), {
                httpMetadata: { contentType: mimeType },
                ...(options?.metadata ? { customMetadata: options.metadata } : {}),
            });
            return `r2://${bucketName}/${destinationPath}`;
        },

        async openStream(objectPath: string, range?: BlobRange): Promise<BlobRead | null> {
            const object = await bucket.get(
                objectPath,
                range ? { range: { offset: range.offset, length: range.length } } : undefined,
            );
            if (!object) return null;
            if (!object.body) {
                // R2 returns a bodyless object for a HEAD-like get, and for a
                // range that starts at or past the end of the object. Treating
                // it as absent would be wrong (the object exists), so surface
                // an empty stream and let the caller's range handling decide.
                return {
                    body: emptyStream(),
                    size: 0,
                    totalSize: object.size,
                    mimeType: object.httpMetadata?.contentType,
                    ...(object.customMetadata ? { metadata: object.customMetadata } : {}),
                };
            }
            return {
                body: object.body,
                // `object.size` is the TOTAL object size even on a ranged get,
                // so the length of this read has to be computed rather than
                // read off. Getting this wrong yields a Content-Length that
                // disagrees with the bytes sent, which hangs clients.
                size: rangeLength(object.size, range),
                totalSize: object.size,
                mimeType: object.httpMetadata?.contentType,
                ...(object.customMetadata ? { metadata: object.customMetadata } : {}),
            };
        },

        async stat(objectPath: string): Promise<BlobStat | null> {
            const meta = await bucket.head(objectPath);
            if (!meta) return null;
            return {
                size: meta.size,
                mimeType: meta.httpMetadata?.contentType,
                ...(meta.customMetadata ? { metadata: meta.customMetadata } : {}),
            };
        },

        async download(objectPath: string): Promise<Uint8Array | null> {
            const object = await bucket.get(objectPath);
            if (!object) return null;
            return new Uint8Array(await object.arrayBuffer());
        },

        extractObjectPath(url: string): string | null {
            const r2 = R2_URL.exec(url);
            if (r2) return decodeURIComponent(r2[2]);

            const gcs = LEGACY_GCS.exec(url);
            if (gcs) return decodeURIComponent(gcs[1]);

            const firebase = LEGACY_FIREBASE.exec(url);
            if (firebase) return decodeURIComponent(firebase[1]);

            return null;
        },
    };
}

/** Byte length a ranged read will actually produce. */
function rangeLength(totalSize: number, range?: BlobRange): number {
    if (!range) return totalSize;
    const available = Math.max(0, totalSize - range.offset);
    return range.length === undefined ? available : Math.min(range.length, available);
}

/**
 * `Uint8Array` → `ArrayBuffer` without copying when the view already spans its
 * whole buffer, which is the common case. A `subarray` view would otherwise
 * upload the entire backing buffer rather than the slice the caller meant — a
 * silent corruption, not an error.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return bytes.buffer as ArrayBuffer;
    }
    return bytes.slice().buffer as ArrayBuffer;
}

function emptyStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.close();
        },
    });
}
