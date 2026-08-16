/**
 * Rendition paths are DERIVED from a source CID and a format:
 *
 *     renditions/{originAppId}/{sourceCid}.{format}
 *
 * ## Why this departs from `blobs/{originAppId}/{cid}`
 *
 * The neighbouring case does the opposite and it is worth being explicit about
 * why. `writeDerivedBlob` content-addresses derived (denoised) audio, because
 * that CID goes **into a record**: the processed blob is referenced by a
 * `BlobRef`, so it has to be portable and self-describing.
 *
 * A rendition is referenced by nothing. No lexicon record points at it, no
 * `at://` uri contains it, and nothing outside this service needs to name it
 * without also knowing the source. Content-addressing it would buy portability
 * nobody consumes and cost a `(sourceCid, format) → derivedCid` lookup on every
 * read — which, on a cache hit, is the whole request. A deterministic path
 * resolves in the Worker with zero database round trip.
 *
 * ## It also closes a vulnerability rather than porting one
 *
 * The service this replaces takes a source **URL** from an anonymous caller and
 * reads the cache key off that URL's own path. Which means a caller who can
 * name the path can name the cache key: host-only allowlisting would let an
 * attacker host `blobs/voxpop/{victim CID}` in their own public bucket, have
 * attacker audio transcoded into the victim's cache slot, and served
 * `immutable` from then on. That service needs a pinned bucket to close it.
 *
 * Here the path is composed from a tenant-scoped CID the service resolved
 * itself. There is no attacker-authored source to pin against, so the whole
 * apparatus — URL parsing, host allowlist, bucket pin — has nothing to do.
 */

/**
 * The formats a requester may ask for.
 *
 * **Closed by construction, and that is load-bearing.** ffmpeg is invoked with
 * a fixed argument vector per format, chosen by this key — the format name must
 * never reach ffmpeg as data. A requester-influenced argument list built by
 * string concatenation is arbitrary file write and worse.
 *
 * The vectors themselves live in the transcode service, not here: which flags
 * produce a good mp3 is adapter policy, the same reasoning that keeps the
 * trimmer's silence threshold out of `TrimmerPort`. What this module owns is
 * the set of names that are legal at all, plus what each one is called and
 * served as.
 *
 * `mp3` alone for now — it is the format with a consumer (Twilio `<Play>`
 * cannot decode webm/opus, and does not say so: it plays static). Adding `wav`
 * or `m4a` is an entry here plus a vector in the service, and needs no route,
 * schema, or view change. That is the property the derived path was chosen for.
 */
export const RENDITION_FORMATS = {
    mp3: { extension: 'mp3', mimeType: 'audio/mpeg' },
} as const satisfies Record<string, { extension: string; mimeType: string }>;

export type RenditionFormat = keyof typeof RENDITION_FORMATS;

/** The format names, for schema declaration and for error messages. */
export const RENDITION_FORMAT_NAMES = Object.keys(RENDITION_FORMATS) as RenditionFormat[];

/** Narrow an arbitrary string to a supported format, or null. */
export function asRenditionFormat(value: string | undefined): RenditionFormat | null {
    if (!value) return null;
    // Case-folded on the way in so `?format=MP3` works, but compared against
    // the closed set rather than passed through — the value that reaches the
    // path and the service is always one of our own literals, never the
    // caller's bytes.
    const normalised = value.trim().toLowerCase();
    return (RENDITION_FORMAT_NAMES as string[]).includes(normalised)
        ? (normalised as RenditionFormat)
        : null;
}

/** The content type to serve a rendition as. */
export function renditionMimeType(format: RenditionFormat): string {
    return RENDITION_FORMATS[format].mimeType;
}

/** Sanity pattern for path segments — same as `blob-path.ts`, and for the same reason. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Derive the storage object path for a rendition. Returns null when either
 * segment is unsafe.
 *
 * Note the format is NOT checked against `SAFE_SEGMENT`: it is a
 * `RenditionFormat`, so it is one of this module's own literals by the type
 * system, and re-validating a value that cannot be caller-authored would
 * suggest it might be.
 */
export function renditionObjectPath(
    originAppId: string,
    sourceCid: string,
    format: RenditionFormat,
): string | null {
    if (!SAFE_SEGMENT.test(originAppId) || !SAFE_SEGMENT.test(sourceCid)) return null;
    return `renditions/${originAppId}/${sourceCid}.${RENDITION_FORMATS[format].extension}`;
}

/**
 * Recover `{originAppId, cid}` from a canonical blob path.
 *
 * The audio route is handed `blobs/{originAppId}/{cid}` and has to reach the
 * rendition for the same source, so it needs the two segments back. Parsing
 * here rather than at the call site keeps the path SHAPE — and the assumption
 * that it has exactly three segments — in the same file that builds it.
 */
export function parseBlobObjectPath(
    objectPath: string,
): { originAppId: string; cid: string } | null {
    const segments = objectPath.split('/');
    if (segments.length !== 3 || segments[0] !== 'blobs') return null;
    const [, originAppId, cid] = segments;
    if (!SAFE_SEGMENT.test(originAppId) || !SAFE_SEGMENT.test(cid)) return null;
    return { originAppId, cid };
}
