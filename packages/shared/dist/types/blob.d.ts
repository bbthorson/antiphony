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
export declare const BlobRefSchema: z.ZodObject<{
    /** Discriminator for AT Protocol type system */
    $type: z.ZodLiteral<"blob">;
    /** Content Identifier (CID) or URL pointing to the blob */
    ref: z.ZodString;
    /** MIME type of the blob (e.g., 'audio/webm') */
    mimeType: z.ZodString;
    /** Size of the blob in bytes */
    size: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    $type: "blob";
    ref: string;
    mimeType: string;
    size: number;
}, {
    $type: "blob";
    ref: string;
    mimeType: string;
    size: number;
}>;
export type BlobRef = z.infer<typeof BlobRefSchema>;
/**
 * Resolve the audio URL from a record that may have either `audio` (BlobRef)
 * or `audioUrl` (legacy string) field.
 *
 * Prefers BlobRef.ref if present, falls back to audioUrl.
 */
export declare function resolveAudioUrl(record: {
    audio?: BlobRef;
    audioUrl?: string;
}): string | undefined;
