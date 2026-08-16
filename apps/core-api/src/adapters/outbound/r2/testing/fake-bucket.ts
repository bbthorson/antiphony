import type {
    R2BucketLike,
    R2GetOptions,
    R2ObjectBodyLike,
    R2ObjectMeta,
    R2PutOptions,
} from '../bucket.js';

/**
 * In-memory `R2BucketLike` for the binding tests.
 *
 * Written against the four methods `bucket.ts` declares, so it is obviously
 * complete rather than plausibly complete — that is most of the reason the
 * interface is declared structurally instead of imported.
 *
 * It reproduces the two R2 behaviours the binding actually depends on, both of
 * which are easy to get wrong from memory and neither of which a looser fake
 * would exercise:
 *
 *  1. `size` on a ranged `get` is the **total object size**, not the length of
 *     the range returned. The binding computes the read length itself for
 *     exactly this reason.
 *  2. A range starting at or past the end yields an object with a **null
 *     body**, not a null object. The object exists; the range is empty.
 *
 * This is a fake, not a mock: no assertions on calls, just storage that behaves
 * like the real thing for the surface in use. When the bucket exists, the same
 * suite should run against it with this swapped out.
 */

interface StoredObject {
    bytes: Uint8Array;
    contentType?: string;
}

export interface FakeBucket extends R2BucketLike {
    /** Direct access for assertions and seeding. */
    readonly objects: Map<string, StoredObject>;
}

export function createFakeBucket(): FakeBucket {
    const objects = new Map<string, StoredObject>();

    return {
        objects,

        async put(key: string, value: unknown, options?: R2PutOptions): Promise<unknown> {
            objects.set(key, {
                bytes: toBytes(value),
                contentType: options?.httpMetadata?.contentType,
            });
            return { key };
        },

        async head(key: string): Promise<R2ObjectMeta | null> {
            const stored = objects.get(key);
            if (!stored) return null;
            return {
                size: stored.bytes.byteLength,
                httpMetadata: { contentType: stored.contentType },
            };
        },

        async get(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null> {
            const stored = objects.get(key);
            if (!stored) return null;

            const total = stored.bytes.byteLength;
            const offset = options?.range?.offset ?? 0;
            const length = options?.range?.length;
            const end = length === undefined ? total : Math.min(offset + length, total);
            const slice = offset >= total ? new Uint8Array(0) : stored.bytes.slice(offset, end);

            const meta = {
                // Deliberately the TOTAL size, matching R2 — a fake that
                // returned the slice length here would let a binding bug
                // through unnoticed.
                size: total,
                httpMetadata: { contentType: stored.contentType },
            };

            if (offset >= total) {
                return {
                    ...meta,
                    body: null,
                    async arrayBuffer() {
                        return new ArrayBuffer(0);
                    },
                };
            }

            return {
                ...meta,
                body: streamOf(slice),
                async arrayBuffer() {
                    return slice.slice().buffer as ArrayBuffer;
                },
            };
        },
    };
}

function toBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    throw new Error('fake bucket: unsupported put() value');
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

/** Collect a stream to bytes — the assertion helper every test here needs. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}
