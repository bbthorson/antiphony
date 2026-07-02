import { z } from 'zod';

/**
 * AT Protocol Blob Reference — the canonical atproto JSON shape:
 *
 *     { "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType", "size" }
 *
 * `ref.$link` is a REAL content CID (CIDv1, raw codec, sha2-256 over the
 * blob bytes), computed at upload time. Storage location is derived from the
 * CID (`blobs/{originAppId}/{cid}`), never stored on the record — records
 * carry content addresses, not provider URLs, so they stay portable.
 */
export const BlobRefSchema = z.object({
    /** Discriminator for AT Protocol type system */
    $type: z.literal('blob'),
    /** IPLD link to the blob bytes: the content CID. */
    ref: z.object({
        $link: z.string().min(1),
    }),
    /** MIME type of the blob (e.g., 'audio/webm') */
    mimeType: z.string(),
    /** Size of the blob in bytes */
    size: z.number().int().min(0),
});
export type BlobRef = z.infer<typeof BlobRefSchema>;
