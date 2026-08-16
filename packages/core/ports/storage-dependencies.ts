/**
 * `BlobStore` is the portable interface for audio (and generic binary) storage.
 * Bindings live in `apps/core-api/src/adapters/outbound/` — Firebase Storage
 * today, R2 alongside it. Alternative backends (S3-compatible, local
 * filesystem) plug in by implementing this interface.
 *
 * ## Bytes are `Uint8Array`, not `Buffer`
 *
 * `Buffer` is a Node built-in, and a Node type in a port whose whole purpose is
 * portability is a leak — it cannot be honoured by a Workers runtime at all.
 * `Uint8Array` is the web-standard supertype, so a Node binding can still hand
 * a `Buffer` back (it IS one) while a Workers binding is not asked to invent
 * one.
 *
 * ## No `getSignedUrl`
 *
 * It was here because the audio proxy 302'd to a time-limited GCS URL. That
 * does not port: R2 bindings cannot mint presigned URLs — presigning needs S3
 * API credentials and an SigV4 implementation, i.e. a stored key doing work the
 * binding is already authorised for.
 *
 * `openStream` replaces it, and the proxy serves bytes rather than redirecting.
 * That is better on every axis that matters here: no credential to store, no
 * expiry to tune, no second hop for the client, egress is free on R2, and range
 * requests work through the same path instead of depending on whatever the
 * redirect target happens to support. It also removes the caveat that a browser
 * `fetch()` of the proxy never worked, because following the redirect required
 * CORS on the bucket.
 */

/** A byte range, as `Range` semantics: `offset` is inclusive, `length` is a count. */
export interface BlobRange {
    offset: number;
    length?: number;
}

/** An open read against a stored object. */
export interface BlobRead {
    /**
     * The object's bytes. A web `ReadableStream` rather than a Node one so the
     * port stays runtime-neutral — a Node binding converts with
     * `Readable.toWeb`, and a Workers binding already has one.
     */
    body: ReadableStream<Uint8Array>;
    /** Size of THIS read (the range, when one was requested), if known. */
    size?: number;
    /** Total size of the object regardless of range, if known. */
    totalSize?: number;
    /** Content type recorded at upload, if the backend kept it. */
    mimeType?: string;
}

export interface BlobStore {
    /**
     * Upload bytes to `destinationPath`. Returns the canonical URL for the
     * stored object (provider-specific). Callers persist it as-is and use
     * `extractObjectPath` to recover the path later.
     */
    upload(bytes: Uint8Array, destinationPath: string, mimeType: string): Promise<string>;

    /**
     * Open an object for streaming, optionally a byte range. Returns null when
     * the object does not exist — absence is an expected answer here (a CID
     * that was never uploaded), not an error.
     *
     * Prefer this over `download` for anything served to a client: it does not
     * materialise the object, which matters against a 128 MB Workers isolate.
     */
    openStream(objectPath: string, range?: BlobRange): Promise<BlobRead | null>;

    /**
     * Read an object's full bytes, or null when absent.
     *
     * Kept alongside `openStream` because the processing pipeline genuinely
     * needs the whole buffer resident — a transcoder cannot work from a
     * half-arrived stream. Callers that are merely relaying bytes to a client
     * should use `openStream` instead.
     */
    download(objectPath: string): Promise<Uint8Array | null>;

    /**
     * Extract the storage object path from a full provider URL. Returns null
     * for a URL this provider does not recognise. Implementations MAY accept
     * several shapes (current and legacy).
     */
    extractObjectPath(url: string): string | null;
}
