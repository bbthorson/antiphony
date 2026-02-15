import { z } from 'zod';

/**
 * AT Protocol Blob Reference.
 *
 * Represents a reference to a binary blob (audio, image, etc.) stored
 * outside the record itself. This aligns with AT Protocol's blob handling
 * where binary data is stored in the PDS blob store with a CID reference.
 *
 * During the transition from `audioUrl: string` to `audio: BlobRef`,
 * both fields coexist. Use `resolveAudioUrl()` to get the correct URL.
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

/**
 * Resolve the audio URL from a record that may have either `audio` (BlobRef)
 * or `audioUrl` (legacy string) field.
 *
 * Prefers BlobRef.ref if present, falls back to audioUrl.
 */
export function resolveAudioUrl(record: { audio?: BlobRef; audioUrl?: string }): string | undefined {
    if (record.audio?.ref) return record.audio.ref;
    return record.audioUrl;
}
