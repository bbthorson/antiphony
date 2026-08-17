import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { servicesFor } from '../../../composition.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';
import {
    asRenditionFormat,
    type RenditionFormat,
    parseBlobObjectPath,
    renditionMimeType,
    renditionObjectPath,
    RENDITION_FORMAT_NAMES,
} from '../../../lib/rendition-path.js';

/**
 * GET /api/v1/audio?url={encodedAudioUrl}
 *
 * Audio proxy. Validates the referenced object path is one we serve —
 * the content-addressed blob namespace (`blobs/{originAppId}/{cid}`, see
 * lib/blob-path.ts) — and returns a 302 redirect to a time-limited signed
 * URL (1-hour expiry default, cached to the client for 50 min).
 */

const prefixedPath = (p: string): boolean => p.startsWith('blobs/');

/**
 * Defense-in-depth against path-traversal bypasses. GCS uses a flat
 * namespace so `..` has no special meaning to the storage layer, but a
 * `..`-containing path that passes the prefix check could escape the
 * allowlist in a hypothetical future storage backend that interprets
 * path segments (local filesystem, S3 with simulated directories, etc.).
 * Reject anywhere on the path — `audio/../../secrets` should fail even
 * though it starts with `audio/`.
 */
const hasTraversalSegment = (p: string): boolean =>
    p.split('/').some((seg) => seg === '..');

/**
 * Treat the input as an object path when it is not a recognised URL.
 *
 * Anything with a scheme is rejected outright: a caller passing
 * `https://evil.example/...` must fail the URL parse and NOT then be
 * reinterpreted as a relative path. The allowlist checks below still apply to
 * whatever comes back.
 */
const bareObjectPath = (value: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    return value.startsWith('/') ? null : value;
};

/**
 * The rate-limit bucket for one audio request: the object being asked for, and
 * the format it is wanted in.
 *
 * ## Why not the client IP
 *
 * Twilio fetches `<Play>` URLs from a small pool of its own addresses, so an
 * IP key puts every concurrent CALL IN THE SYSTEM into a handful of buckets: a
 * busy period throttles live audio, and the thing being limited is unrelated
 * requests colliding rather than anyone abusing anything. Keying on the object
 * bounds what the limit is actually here to bound — repeated demand for the
 * SAME rendition, which on a miss is a repeated ffmpeg transcode.
 *
 * Format is part of the key because the cost is per (object, format): a
 * canonical stream and an mp3 transcode of the same blob are different work.
 *
 * ## Why this returns null so readily
 *
 * It runs BEFORE the handler validates anything, so every input here is
 * hostile until proven otherwise. Anything that is not a well-formed path in
 * the served namespace — junk, traversal, an unknown format — returns null and
 * falls back to the caller's IP bucket. That is the load-bearing half: a key
 * derived from the request has unbounded cardinality, so if arbitrary input
 * could mint a bucket, an attacker would get a fresh limit on every request by
 * varying one character. Only paths this service would actually serve get
 * their own bucket, and `RATE_LIMITS.readAggregate` bounds the rest.
 */
export const audioBucketKey = (c: Context): string | null => {
    const raw = c.req.query('url');
    if (!raw) return null;

    const objectPath =
        servicesFor(c.env as Record<string, unknown> | undefined).storage.extractObjectPath(raw) ??
        bareObjectPath(raw);
    if (!objectPath || !prefixedPath(objectPath) || hasTraversalSegment(objectPath)) return null;

    const requested = c.req.query('format');
    if (requested === undefined) return `audio:canonical:${objectPath}`;
    const format = asRenditionFormat(requested);
    // An unsupported format is a 400 from the handler. Keying it would let a
    // caller mint buckets from the format slot as easily as from the path.
    return format ? `audio:${format}:${objectPath}` : null;
};

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// `url` is declared optional in the ZOD schema so the OpenAPIHono validator
// doesn't pre-empt the handler's own "Missing url" 400 (which carries a
// specific message the embed + clients rely on). It IS required — the param
// metadata says so for the generated doc; the handler guard below enforces it.
const QuerySchema = z.object({
    url: z
        .string()
        .optional()
        .openapi({
            param: { name: 'url', in: 'query', required: true },
            description:
                'REQUIRED. The object path of the audio to serve, or a canonical storage URL. ' +
                'Must resolve to an object under the content-addressed blob namespace (`blobs/`). Returns 400 if absent.',
            example: 'blobs/<originAppId>/<cid>',
        }),
    format: z
        .string()
        .optional()
        .openapi({
            param: { name: 'format', in: 'query', required: false },
            description:
                'Optional. Serve a derived rendition of the audio instead of the canonical bytes. ' +
                `One of: ${RENDITION_FORMAT_NAMES.join(', ')}. Omitted, the stored audio is served as-is.\n\n` +
                'Read-path only: the canonical blob is never re-encoded, because its CID is what every ' +
                'record, blob ref, and dedup guarantee rides on.',
            example: 'mp3',
        }),
});

const proxyRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Audio'],
    summary: 'Stream stored audio',
    description:
        'Validates the requested object path against the served namespace (content-addressed `blobs/` paths) ' +
        'then STREAMS the bytes. Anonymous — public audio playback for embeds and public pages.\n\n' +
        'Accepts either a full provider URL or a bare object path. Supports a single `Range` header ' +
        '(`bytes=start-end`) and answers 206; an unparseable or multi-range header is ignored and the ' +
        'whole object is served. Responses are `immutable` — the bytes behind a content address never change.\n\n' +
        '**Changed in 0.5.0:** this used to 302-redirect to a short-lived signed URL. It now returns the ' +
        'audio directly. Clients using `<audio src>` need no change; anything asserting on the redirect does.\n\n' +
        'Pass `format` to receive a derived rendition (e.g. `mp3` for telephony playback, which cannot ' +
        'decode webm/opus) instead of the canonical bytes. The canonical audio is never re-encoded.',
    middleware: [
        // TWO limits, and they are not redundant. The aggregate one is IP-keyed
        // and deliberately loose — it exists only because the object-keyed limit
        // below has unbounded cardinality and therefore no aggregate bound of
        // its own. The tight one is what actually governs demand for a single
        // rendition. Aggregate first, so a flood is refused before it costs a
        // second store round trip.
        rateLimit(RATE_LIMITS.readAggregate, { exemptServiceCallers: true }),
        rateLimit(RATE_LIMITS.read, { exemptServiceCallers: true, keyBy: audioBucketKey }),
    ] as const,
    request: { query: QuerySchema },
    responses: {
        200: {
            description: 'The audio bytes.',
            content: { 'audio/*': { schema: { type: 'string', format: 'binary' } } },
        },
        206: {
            description: 'The requested byte range, with `Content-Range`.',
            content: { 'audio/*': { schema: { type: 'string', format: 'binary' } } },
        },
        400: errorResponse('Missing or malformed `url`, or an unsupported `format`'),
        403: errorResponse('Object path outside the served allowlist'),
        404: errorResponse('Backing object not found, or no rendition in the requested format'),
    },
});

app.openapi(proxyRoute, async (c) => {
    const { url: audioUrl, format: requestedFormat } = c.req.valid('query');
    if (!audioUrl) {
        return c.json(errorEnvelope(c, 'Missing "url" query parameter'), 400);
    }

    // Rejected rather than ignored. An unknown format silently serving the
    // canonical webm/opus is the worst available answer for the caller this
    // exists for: Twilio cannot decode it and does not say so — it plays
    // static. A 400 is a caller-fixable error; static is a mystery.
    const format = requestedFormat === undefined ? null : asRenditionFormat(requestedFormat);
    if (requestedFormat !== undefined && format === null) {
        return c.json(
            errorEnvelope(c, `Unsupported format. Supported: ${RENDITION_FORMAT_NAMES.join(', ')}`),
            400,
        );
    }

    // Accept either a full provider URL (what older records carry) or a bare
    // object path. The bare-path form is what `audioPlaybackUrl` now emits, and
    // it is what this endpoint's own OpenAPI description has always claimed to
    // take — the code only ever handled URLs, so this closes that gap rather
    // than widening the contract.
    const services = servicesFor(c.env);
    const objectPath = services.storage.extractObjectPath(audioUrl) ?? bareObjectPath(audioUrl);
    if (!objectPath) {
        return c.json(errorEnvelope(c, 'Invalid audio URL'), 400);
    }

    if (!prefixedPath(objectPath) || hasTraversalSegment(objectPath)) {
        return c.json(errorEnvelope(c, 'Forbidden path'), 403);
    }

    // A single `bytes=` range, which is what every audio element sends when
    // seeking. Multi-range (`bytes=0-1,5-6`) is deliberately unsupported: it
    // requires a multipart/byteranges response, no audio client asks for one,
    // and RFC 9110 permits ignoring the header entirely — so an unparseable or
    // multi-range header falls through to a normal 200.
    const range = parseRange(c.req.header('range'));

    // With a format asked for, serve the DERIVED object instead. The path is
    // computed from the source's own tenant and CID — no lookup, no round trip
    // — so a cache hit costs exactly one storage read, which on this path is
    // the whole request.
    //
    // On a MISS, ask the transcode service and read again — see § Transcoding
    // on demand below the handler for the abuse bound, which is the part of
    // this worth understanding.
    const servePath = format ? renditionPathFor(objectPath, format) : objectPath;
    if (!servePath) {
        return c.json(errorEnvelope(c, 'Forbidden path'), 403);
    }

    let read = await services.storage.openStream(servePath, range ?? undefined);

    if (!read && format && services.renditionService) {
        const source = parseBlobObjectPath(objectPath);
        // `source` cannot be null here — `renditionPathFor` above returned a
        // path, which means it parsed. Checked anyway rather than asserted,
        // because the alternative is a non-null assertion on the value that
        // composes a storage key.
        if (source) {
            const built = await services.renditionService.ensure({ ...source, format });
            // Re-read rather than trusting the answer. The service writes to R2
            // and we read from R2, so the read is the only thing that actually
            // establishes the rendition is servable — and on a `false` it may
            // still have landed, because our budget elapsing does not cancel
            // the transcode.
            if (built) read = await services.storage.openStream(servePath, range ?? undefined);
        }
    }

    if (!read) {
        return c.json(
            errorEnvelope(
                c,
                format ? `No ${format} rendition available for this audio` : 'Audio not found',
            ),
            404,
        );
    }

    // Content-addressed: the bytes behind a CID never change, so this is as
    // cacheable as anything gets. The old signed-URL indirection could not say
    // this — it was `private, max-age=3000` purely because the URL expired.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Accept-Ranges', 'bytes');
    // A rendition's type comes from the FORMAT, not from what the store
    // happens to report. The store's answer is whatever was set when the
    // object was written, and an mp3 served as `application/octet-stream`
    // because a `Content-Type` went missing is exactly the kind of thing
    // Twilio reacts to by playing nothing.
    c.header(
        'Content-Type',
        format ? renditionMimeType(format) : (read.mimeType ?? 'application/octet-stream'),
    );
    c.header('Content-Length', String(read.size ?? 0));

    if (range && read.totalSize !== undefined) {
        const last = range.offset + (read.size ?? 0) - 1;
        c.header('Content-Range', `bytes ${range.offset}-${Math.max(range.offset, last)}/${read.totalSize}`);
        return c.body(read.body, 206);
    }

    // HEAD must carry the same headers and no body — `<audio>` and Twilio both
    // probe with one before committing to a fetch.
    if (c.req.method === 'HEAD') return c.body(null, 200);

    return c.body(read.body, 200);
});

/**
 * ## Transcoding on demand — and why an anonymous route may trigger ffmpeg
 *
 * Before the miss path existed, a request for an absent rendition was free: a
 * 404 and nothing else. Now it can start a transcode, on a route with no
 * credential. That deserves stating plainly rather than being left implicit.
 *
 * **The work is bounded by the corpus, not by the request rate.** Renditions
 * are cached, so a given `(cid, format)` costs one ffmpeg run ever — every
 * subsequent request for it is a storage read. And the service refuses any pair
 * whose SOURCE blob does not exist. So the total transcode work a caller can
 * ever cause is `(blobs that exist) × (formats)`, however many requests they
 * send. That is a fundamentally different shape from an open transcoding proxy,
 * which is what the service looked like before it moved behind this route.
 *
 * What remains is a burst: many distinct real CIDs requested at once queues
 * that many transcodes. Two things bound it — `--max-instances` on the service
 * caps concurrent spend, and the per-tenant eager opt-in means the renditions
 * anyone actually plays are already warm, so the lazy path is the tail rather
 * than the norm.
 *
 * **The rate limit here is keyed on the OBJECT, not the client IP** — the
 * change that makes this route safe for telephony.
 *
 * Twilio fetches `<Play>` URLs from a small pool of its own addresses and
 * cannot present a credential (bare `GET`, no headers under our control), so an
 * IP key collapsed every concurrent call in the system into a handful of
 * buckets: a busy period throttled live audio, and no exemption could reach it.
 * `audioBucketKey` keys on `(objectPath, format)` instead, which is also what
 * the limit is actually for — repeated demand for one rendition is a repeated
 * ffmpeg transcode on a miss, while two different calls playing two different
 * clips are not competing for anything.
 *
 * Three properties hold this together, and removing any one breaks it:
 *
 *   1. **Unkeyable input falls back to the IP.** Junk, traversal, and unknown
 *      formats do not mint buckets — otherwise varying one character would
 *      hand an attacker a fresh limit per request.
 *   2. **An IP-keyed aggregate sits above it** (`RATE_LIMITS.readAggregate`,
 *      deliberately loose) because even well-formed keys are unbounded in
 *      number. Object keying bounds per-object cost; that bounds total cost.
 *   3. **Authenticated siblings are exempt** from both, since a peer's entire
 *      traffic shares one address for the same reason Twilio's does.
 *
 * Cost: two store round trips per anonymous request instead of one. Cheap
 * against an R2 read, and far cheaper than a transcode.
 */

/**
 * The rendition object path for a canonical blob path, or null if the blob
 * path is not the shape renditions are derived from.
 *
 * Null here becomes a 403 rather than a 404, matching the allowlist refusal
 * above it: a path that reaches this point has already passed the `blobs/`
 * prefix and traversal checks, so failing to parse means it is a shape this
 * service does not serve — not an object that is missing.
 */
function renditionPathFor(objectPath: string, format: RenditionFormat): string | null {
    const source = parseBlobObjectPath(objectPath);
    if (!source) return null;
    return renditionObjectPath(source.originAppId, source.cid, format);
}

/**
 * Parse a single-range `Range` header into a byte offset and length.
 *
 * Returns null for anything not understood, which the caller treats as "serve
 * the whole object" — the behaviour RFC 9110 permits and the safest failure
 * mode, since a misparsed range serves the wrong bytes under a 206 that claims
 * they are right.
 *
 * Suffix ranges (`bytes=-500`, meaning the LAST 500 bytes) are not handled
 * here: resolving one needs the object size, which the store has not been asked
 * for yet at this point. They fall through to a 200, which is correct if
 * wasteful, and no audio client this serves emits them.
 */
function parseRange(header: string | undefined): { offset: number; length?: number } | null {
    if (!header) return null;
    const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    if (match[2] === '') return { offset };
    const end = Number(match[2]);
    if (!Number.isSafeInteger(end) || end < offset) return null;
    return { offset, length: end - offset + 1 };
}

export { app as audioRoute };
