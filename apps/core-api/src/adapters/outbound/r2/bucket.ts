/**
 * The slice of Cloudflare's `R2Bucket` this codebase actually uses.
 *
 * Declared structurally rather than by importing `@cloudflare/workers-types`,
 * for two reasons:
 *
 *  - core-api still builds and runs as a Node service. Pulling the full Workers
 *    ambient type package in would put `Request`/`Response`/`fetch` globals
 *    from another runtime into scope everywhere, which is a real source of
 *    "compiles, then behaves differently" once the two runtimes coexist.
 *  - Four methods is a small enough surface that naming them is cheaper than
 *    depending on a package to name them, and it makes the in-memory fake in
 *    the tests obviously complete rather than plausibly complete.
 *
 * The real `R2Bucket` satisfies this interface structurally, so binding it in a
 * Worker needs no adapter or cast.
 */

export interface R2PutOptions {
    httpMetadata?: { contentType?: string };
}

export interface R2GetOptions {
    /** R2 accepts `{ offset, length }`; both are byte counts. */
    range?: { offset: number; length?: number };
}

export interface R2ObjectMeta {
    /** Size of the whole object, not of a requested range. */
    size: number;
    httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectMeta {
    body: ReadableStream<Uint8Array> | null;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
    put(
        key: string,
        value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
        options?: R2PutOptions,
    ): Promise<unknown>;
    get(key: string, options?: R2GetOptions): Promise<R2ObjectBodyLike | null>;
    head(key: string): Promise<R2ObjectMeta | null>;
}
