import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { SpaceViewSchema } from 'shared/types/spaces';
import { DidStringSchema } from 'shared/types/dids';
import { DeleteSpaceResultSchema } from 'shared/types/deletion';
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
 *   DELETE /{spaceType}/{skey} — delete an empty one (specs/deletion.md § 4.3)
 *
 * A space's authority is the calling tenant's own app DID unless `?authority=`
 * names a DID the tenant registered (specs/did-plc-and-multi-did-tenancy.md §3),
 * so the path names only `{ type, skey }`. Tenant-level, so a service token is
 * enough: no acting actor is needed to manage the tenant's own spaces.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const SpaceParamsSchema = z.object({
    spaceType: z.string().openapi({ description: 'The space type, an NSID (e.g. `game.bardcast.space.campaign`)' }),
    skey: z.string().openapi({ description: 'The space key, in record-key syntax. A DID is a valid skey.' }),
});

const AuthorityQuerySchema = z.object({
    authority: DidStringSchema.optional().openapi({
        description:
            "The space's authority, when it isn't the app's own DID: a DID the app registered with `PUT /api/v1/dids/{did}`.",
    }),
});

/** The space key a request names: its path, plus `?authority=` when given. */
const keyOf = (param: { spaceType: string; skey: string }, query: { authority?: string | undefined }) => ({
    type: param.spaceType,
    skey: param.skey,
    ...(query.authority !== undefined ? { authority: query.authority } : {}),
});

const putRoute = createRoute({
    method: 'put',
    path: '/{spaceType}/{skey}',
    tags: ['Spaces'],
    summary: 'Create or replace a space',
    description:
        'Creates the space `at://{authority}/space/{spaceType}/{skey}`, or replaces its policies (replace, not merge: ' +
        'an omitted policy goes back to `member-list`). Idempotent. Posts and audio uploaded into a space are ' +
        'private: their audio plays only through signed, expiring URLs. A deployment without a playback secret ' +
        'refuses to create spaces (503) rather than store audio it could not keep private. `?authority=` puts the ' +
        "space under a DID the app registered (400 `AUTHORITY_NOT_REGISTERED` otherwise; 503 " +
        '`AUTHORITY_CUSTODY_UNPROVEN` when its document no longer names this deployment).',
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
        query: AuthorityQuerySchema,
        body: { content: { 'application/json': { schema: PutSpaceRequestSchema } } },
    },
    responses: {
        200: jsonResponse(SpaceViewSchema, 'The space as stored'),
        400: errorResponse('Invalid space type, key, authority or policies, or an authority the app has not registered'),
        401: errorResponse('Not authenticated'),
        503: errorResponse('No playback secret (`SPACES_UNAVAILABLE`), or the authority\'s custody is unproven right now'),
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
    const body = c.req.valid('json');
    const view = await servicesFor(c.env).spaceService.putSpace({
        originAppId: getOriginAppId(c),
        key: keyOf(c.req.valid('param'), c.req.valid('query')),
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
    request: { params: SpaceParamsSchema, query: AuthorityQuerySchema },
    responses: {
        200: jsonResponse(SpaceViewSchema, 'The space'),
        400: errorResponse('Invalid space type or key'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Space not found'),
    },
});

app.openapi(getRoute, async (c) => {
    const view = await servicesFor(c.env).spaceService.getSpace(getOriginAppId(c), keyOf(c.req.valid('param'), c.req.valid('query')));
    return c.json({ success: true as const, data: view }, 200);
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/{spaceType}/{skey}',
    tags: ['Spaces'],
    summary: 'Delete an empty space',
    description:
        "Deletes one of the calling tenant's spaces, once no post is in it: a post's space is sealed into its URI, " +
        'so a space holding posts answers 409 (`SPACE_NOT_EMPTY`). Delete or erase its posts first. Idempotent: ' +
        '`deleted` is false when there was no such space.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
    ] as const,
    request: { params: SpaceParamsSchema, query: AuthorityQuerySchema },
    responses: {
        200: jsonResponse(DeleteSpaceResultSchema, 'Whether a space was deleted'),
        400: errorResponse('Invalid space type or key'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('The space still holds posts (`SPACE_NOT_EMPTY`)'),
    },
});

app.openapi(deleteRoute, async (c) => {
    const deleted = await servicesFor(c.env).spaceService.deleteSpace(getOriginAppId(c), keyOf(c.req.valid('param'), c.req.valid('query')));
    return c.json({ success: true as const, data: { deleted } }, 200);
});

export { app as spacesRoute };
