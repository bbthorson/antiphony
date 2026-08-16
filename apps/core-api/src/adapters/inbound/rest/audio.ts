import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { servicesFor } from '../../../composition.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

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
        'audio directly. Clients using `<audio src>` need no change; anything asserting on the redirect does.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
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
        400: errorResponse('Missing or malformed `url`'),
        403: errorResponse('Object path outside the served allowlist'),
        404: errorResponse('Backing object not found'),
    },
});

app.openapi(proxyRoute, async (c) => {
    const { url: audioUrl } = c.req.valid('query');
    if (!audioUrl) {
        return c.json(errorEnvelope(c, 'Missing "url" query parameter'), 400);
    }

    // Accept either a full provider URL (what older records carry) or a bare
    // object path. The bare-path form is what `audioPlaybackUrl` now emits, and
    // it is what this endpoint's own OpenAPI description has always claimed to
    // take — the code only ever handled URLs, so this closes that gap rather
    // than widening the contract.
    const objectPath = servicesFor(c.env).storage.extractObjectPath(audioUrl) ?? bareObjectPath(audioUrl);
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

    const read = await servicesFor(c.env).storage.openStream(objectPath, range ?? undefined);
    if (!read) {
        return c.json(errorEnvelope(c, 'Audio not found'), 404);
    }

    // Content-addressed: the bytes behind a CID never change, so this is as
    // cacheable as anything gets. The old signed-URL indirection could not say
    // this — it was `private, max-age=3000` purely because the URL expired.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Accept-Ranges', 'bytes');
    c.header('Content-Type', read.mimeType ?? 'application/octet-stream');
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
