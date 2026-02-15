"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlobRefSchema = void 0;
exports.resolveAudioUrl = resolveAudioUrl;
const zod_1 = require("zod");
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
exports.BlobRefSchema = zod_1.z.object({
    /** Discriminator for AT Protocol type system */
    $type: zod_1.z.literal('blob'),
    /** Content Identifier (CID) or URL pointing to the blob */
    ref: zod_1.z.string(),
    /** MIME type of the blob (e.g., 'audio/webm') */
    mimeType: zod_1.z.string(),
    /** Size of the blob in bytes */
    size: zod_1.z.number(),
});
/**
 * Resolve the audio URL from a record that may have either `audio` (BlobRef)
 * or `audioUrl` (legacy string) field.
 *
 * Prefers BlobRef.ref if present, falls back to audioUrl.
 */
function resolveAudioUrl(record) {
    var _a;
    if ((_a = record.audio) === null || _a === void 0 ? void 0 : _a.ref)
        return record.audio.ref;
    return record.audioUrl;
}
