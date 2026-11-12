/**
 * Verifying an Antiphony webhook signature (`specs/enrichment-webhooks.md`).
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) rather than `node:crypto`, so the
 * same function runs on Cloudflare Workers, Node 22 and in browsers, and this
 * package stays free of runtime dependencies.
 */

export interface VerifyWebhookSignatureInput {
    /** The tenant's webhook secret. */
    secret: string;
    /**
     * The request body EXACTLY as received. The HMAC is over these bytes, so
     * read the body once, verify it, and only then parse it: a body that has
     * been through `JSON.parse` and `JSON.stringify` has different bytes
     * (key order, whitespace, escapes) and will not verify. Pass bytes
     * (`await request.arrayBuffer()`) when you can; a string is UTF-8 encoded
     * as given, which is exact for the valid JSON Antiphony sends.
     */
    rawBody: string | Uint8Array | ArrayBuffer;
    /** The `X-Antiphony-Signature` header value, or nothing if the request had none. */
    signatureHeader: string | null | undefined;
}

const SIGNATURE_FORMAT = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Whether `signatureHeader` is the HMAC-SHA256 of `rawBody` under `secret`.
 *
 * Resolves `false` for every bad input (no header, wrong prefix, non-hex or
 * wrong-length hex, empty secret) and never throws for them. The comparison is
 * done by `crypto.subtle.verify` on the decoded bytes, which is constant-time;
 * comparing hex strings with `===` would not be.
 */
export async function verifyWebhookSignature({
    secret,
    rawBody,
    signatureHeader,
}: VerifyWebhookSignatureInput): Promise<boolean> {
    if (typeof signatureHeader !== 'string' || secret.length === 0) return false;
    const match = SIGNATURE_FORMAT.exec(signatureHeader);
    if (!match) return false;

    // Decoded to bytes so the comparison is over the MAC itself, not its spelling.
    const signature = new Uint8Array(32);
    for (let i = 0; i < 32; i++) signature[i] = parseInt(match[1].slice(i * 2, i * 2 + 2), 16);

    // A copy for caller-supplied bytes: a view may cover part of a larger
    // buffer, and WebCrypto wants exactly the bytes the view addresses.
    const data = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : bytesOf(rawBody);

    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'verify',
    ]);
    return subtle.verify('HMAC', key, signature, data);
}

function bytesOf(body: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
    return body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body.slice(0));
}
