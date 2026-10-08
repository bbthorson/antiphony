import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { SpaceViewSchema } from 'shared/types/spaces';
import { PutSpaceRequestSchema } from 'shared/api-codecs';
import { ServiceError } from 'shared/errors';
import { rateLimit, RATE_LIMITS, actingActorKey } from '../../../middleware/rate-limit.js';
import { requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { playbackSecret } from '../../../lib/app-config.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * A tenant's atproto spaces, mounted at `/api/v1/spaces` (specs/spaces.md, Phase 2).
 *
 *   PUT /{spaceType}/{skey}  — create a space, or replace its policies
 *   GET /{spaceType}/{skey}  — read one
 *
 * A space's authority is always the calling tenant's own DID, so the path names
 * only `{ type, skey }`. Tenant-level, so a service token is enough: no acting
 * actor is needed to manage the tenant's own spaces.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const SpaceParamsSchema = z.object({
    spaceType: z.string().openapi({ description: 'The space type, an NSID (e.g. `game.bardcast.space.campaign`)' }),
    skey: z.string().openapi({ description: 'The space key, in record-key syntax. A DID is a valid skey.' }),
});

const putRoute = createRoute({
    method: 'put',
    path: '/{spaceType}/{skey}',
    tags: ['Spaces'],
    summary: 'Create or replace a space',
    description:
        'Creates the space `at://{appDid}/space/{spaceType}/{skey}`, or replaces its policies (replace, not merge: ' +
        'an omitted policy goes back to `member-list`). Idempotent. Posts and audio uploaded into a space are ' +
        'private: their audio plays only through signed, expiring URLs. A deployment without a playback secret ' +
        'refuses to create spaces (503) rather than store audio it could not keep private.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        bodyLimit({
            maxSize: 16 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: {
        params: SpaceParamsSchema,
        body: { content: { 'application/json': { schema: PutSpaceRequestSchema } } },
    },
    responses: {
        200: jsonResponse(SpaceViewSchema, 'The space as stored'),
        400: errorResponse('Invalid space type, key or policies'),
        401: errorResponse('Not authenticated'),
        503: errorResponse('This deployment has no playback secret, so it cannot keep space audio private'),
    },
});

app.openapi(putRoute, async (c) => {
    if (!playbackSecret()) {
        throw new ServiceError(
            'Spaces are unavailable: this deployment has no ANTIPHONY_PLAYBACK_SECRET',
            503,
            undefined,
            'SPACES_UNAVAILABLE',
        );
    }
    const { spaceType, skey } = c.req.valid('param');
    const body = c.req.valid('json');
    const view = await servicesFor(c.env).spaceService.putSpace({
        originAppId: getOriginAppId(c),
        key: { type: spaceType, skey },
        readPolicy: body.readPolicy,
        writePolicy: body.writePolicy,
        ...(body.managingAppEndpoint ? { managingAppEndpoint: body.managingAppEndpoint } : {}),
    });
    return c.json({ success: true as const, data: view }, 200);
});

const getRoute = createRoute({
    method: 'get',
    path: '/{spaceType}/{skey}',
    tags: ['Spaces'],
    summary: 'Get a space',
    description: "Returns one of the calling tenant's spaces. Another tenant's space reads as 404.",
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
    ] as const,
    request: { params: SpaceParamsSchema },
    responses: {
        200: jsonResponse(SpaceViewSchema, 'The space'),
        400: errorResponse('Invalid space type or key'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Space not found'),
    },
});

app.openapi(getRoute, async (c) => {
    const { spaceType, skey } = c.req.valid('param');
    const view = await servicesFor(c.env).spaceService.getSpace(getOriginAppId(c), { type: spaceType, skey });
    return c.json({ success: true as const, data: view }, 200);
});

export { app as spacesRoute };
