/**
 * Audio MIME negotiation — the two questions every browser client asks around
 * a recording, and the two the browser answers badly.
 *
 * **React-free**, and published at the `@antiphony/capture-kit/mime` subpath
 * for that reason: an uploader is often the one piece of a client that runs
 * outside the component tree.
 */

/** The MediaRecorder container/codec pairs to try, best first. */
const RECORD_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];

/**
 * Pick the first MediaRecorder MIME the browser supports from our allowlist.
 *
 * Exported because it is the answer to "what will this browser actually give
 * me?", which a caller may need *before* recording — to warn on an
 * unsupported browser, or to check the result against a server-side allowlist.
 */
export function pickMimeType(): string {
    for (const c of RECORD_CANDIDATES) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'audio/webm';
}

/**
 * Filename extension → bare audio MIME, for the case below where the blob
 * itself refuses to say what it is.
 */
const EXTENSION_TYPES: Record<string, string> = {
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/m4a',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
};

/**
 * Normalize any audio blob's type to a bare, uploadable audio MIME.
 *
 * An upload route matching an exact allowlist — which Antiphony's does — gets
 * two kinds of input a browser produces and the allowlist rejects:
 *
 *   1. **A codec-suffixed type.** `audio/webm;codecs=opus` is what
 *      MediaRecorder reports, and an exact-match check fails it even though
 *      the base type is allowed.
 *   2. **No type at all.** Some browsers hand back `application/octet-stream`
 *      or `''` — most often for a `File` off an `<input type="file">`, where
 *      the OS never populated one. The filename is the only remaining evidence,
 *      so it is the fallback.
 *
 * `useAudioRecorder` in this package already constructs its `Blob` with a
 * clean type from {@link pickMimeType}, so a recording that came from the kit
 * needs no normalization. This is for the blobs the kit did NOT produce —
 * uploads, drag-and-drop, and anything re-wrapped along the way. Running it
 * unconditionally before an upload is still the right call: it is a no-op on
 * a blob that is already clean, and the case it catches is invisible until a
 * user on the wrong browser gets a 400.
 *
 * @param blobType `blob.type` — may be undefined, empty, or codec-suffixed.
 * @param filename The name the bytes will be uploaded under; consulted only
 *                 when `blobType` carries no usable audio type.
 * @param fallback Used when neither the type nor the extension says anything.
 */
export function normalizeAudioMimeType(
    blobType: string | undefined,
    filename: string,
    fallback = 'audio/webm',
): string {
    // Strip any codec parameter: `audio/mp4; codecs="mp4a.40.2"` → `audio/mp4`.
    const baseType = (blobType || '').split(';')[0].trim().toLowerCase();
    if (baseType.startsWith('audio/')) return baseType;

    const ext = filename.toLowerCase().split('.').pop() ?? '';
    return EXTENSION_TYPES[ext] ?? fallback;
}
