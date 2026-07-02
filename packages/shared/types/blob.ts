import { z } from 'zod';

/**
 * AT Protocol Blob Reference.
 *
 * Represents a reference to a binary blob (audio, image, etc.) stored
 * outside the record itself. This aligns with AT Protocol's blob handling
 * where binary data is stored in the blob store with a CID reference.
 */
export const BlobRefSchema = z.object({
    /** Discriminator for AT Protocol type system */
    $type: z.literal('blob'),
    /** Content Identifier (CID) or URL pointing to the blob */
    ref: z.string(),
    /** MIME type of the blob (e.g., 'audio/webm') */
    mimeType: z.string(),
    /** Size of the blob in bytes */
    size: z.number(),
});
export type BlobRef = z.infer<typeof BlobRefSchema>;
