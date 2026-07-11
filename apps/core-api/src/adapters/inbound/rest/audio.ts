import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';
import { logger } from '../../../lib/logger.js';
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
                'REQUIRED. The canonical storage URL (or object path) of the audio to proxy. ' +
                'Must resolve to an object under the content-addressed blob namespace (`blobs/`). Returns 400 if absent.',
            example: 'https://storage.googleapis.com/<bucket>/blobs/<originAppId>/<cid>',
        }),
});

const proxyRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Audio'],
    summary: 'Resolve audio to a signed URL',
    description:
        'Validates the requested object path against the served namespace (content-addressed `blobs/` paths) ' +
        'then 302-redirects to a short-lived signed URL ' +
        '(~1h TTL, cached ~50m). Anonymous — public audio playback for embeds and public pages.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: { query: QuerySchema },
    responses: {
        302: {
            description:
                'Redirect (Location header) to a time-limited signed URL for the requested object.',
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

    const objectPath = StorageService.extractObjectPath(audioUrl);
    if (!objectPath) {
        return c.json(errorEnvelope(c, 'Invalid audio URL'), 400);
    }

    if (!prefixedPath(objectPath) || hasTraversalSegment(objectPath)) {
        return c.json(errorEnvelope(c, 'Forbidden path'), 403);
    }

    try {
        const signedUrl = await StorageService.getSignedUrl(objectPath);
        // Cache just under the 1-hour signed-URL TTL so clients don't
        // redirect through a URL that's about to expire.
        c.header('Cache-Control', 'private, max-age=3000');
        return c.redirect(signedUrl, 302);
    } catch (err) {
        logger.error(
            { err, objectPath, requestId: c.get('requestId') },
            '[audio-proxy] failed to generate signed URL',
        );
        return c.json(errorEnvelope(c, 'Audio not found'), 404);
    }
});

export { app as audioRoute };
