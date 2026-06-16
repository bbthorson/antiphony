import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { StorageService } from '../../outbound/firebase/core-services-firebase.js';
import { getAdminDb } from '../../../lib/firebase-admin.js';
import { logger } from '../../../lib/logger.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/audio?url={encodedAudioUrl}
 *
 * Audio proxy. Validates the referenced object path is one we serve
 * (prefix allowlist: `audio/`, `prompts/`, `replies/`) and that any
 * `replies/{promptId}/...` path points at a prompt that exists.
 * Returns a 302 redirect to a time-limited signed URL (1-hour expiry
 * default, cached to the client for 50 min).
 *
 * Parity with: apps/web/src/app/api/v1/audio/route.ts. Phase 1 of the
 * signed-URL migration — see `specs/signed-url-migration.md`.
 */

const prefixedPath = (p: string): boolean =>
    p.startsWith('audio/') || p.startsWith('prompts/') || p.startsWith('replies/');

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

// `url` is declared optional so the OpenAPIHono validator doesn't pre-empt
// the handler's own "Missing url" 400 (which carries a specific message the
// embed + clients rely on). It is effectively REQUIRED — see the description
// and the handler guard below.
const QuerySchema = z.object({
    url: z
        .string()
        .optional()
        .openapi({
            param: { name: 'url', in: 'query' },
            description:
                'REQUIRED. The canonical storage URL (or object path) of the audio to proxy. ' +
                'Must resolve to an object under `audio/`, `prompts/`, or `replies/`. Returns 400 if absent.',
            example: 'https://storage.googleapis.com/<bucket>/replies/<promptId>/<userId>_<ts>.webm',
        }),
});

const proxyRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Audio'],
    summary: 'Resolve audio to a signed URL',
    description:
        'Validates the requested object path against the served prefixes (`audio/`, `prompts/`, `replies/`) ' +
        'and, for reply audio, that the parent prompt exists, then 302-redirects to a short-lived signed URL ' +
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
        404: errorResponse('Parent prompt or backing object not found'),
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

    // For reply audio (`replies/{promptId}/{userId}_{timestamp}.ext`),
    // validate the parent prompt exists. Failing open on Firestore hiccup
    // — consistent with apps/web, which doesn't want a transient DB
    // outage to brick all audio playback.
    if (objectPath.startsWith('replies/')) {
        const parts = objectPath.split('/');
        if (parts.length >= 2) {
            const promptId = parts[1];
            try {
                const promptDoc = await getAdminDb().collection('prompts').doc(promptId).get();
                if (!promptDoc.exists) {
                    return c.json(errorEnvelope(c, 'Not found'), 404);
                }
            } catch (err) {
                logger.error(
                    { err, promptId, requestId: c.get('requestId') },
                    '[audio-proxy] error checking prompt existence; failing open',
                );
            }
        }
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
