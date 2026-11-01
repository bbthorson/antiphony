import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { TenantDidViewSchema } from 'shared/types/dids';
import { RegisterDidRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS, actingActorKey } from '../../../middleware/rate-limit.js';
import { requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * The DIDs a tenant may write under besides its app DID, mounted at
 * `/api/v1/dids` (specs/did-plc-and-multi-did-tenancy.md §3).
 *
 *   PUT /{did}  — register one (custody proven first)
 *   GET /{did}  — read one of the tenant's registrations
 *   GET /       — list them, newest first
 *   DELETE /{did} — unregister one nothing is under
 *
 * Tenant-level, so a service token is enough. Once registered, a DID can be the
 * `authority` of posts and spaces.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const DidParamsSchema = z.object({
    did: z.string().openapi({ description: 'The DID, e.g. `did:plc:…` (URL-encode its colons or not; both work).' }),
});

const putRoute = createRoute({
    method: 'put',
    path: '/{did}',
    tags: ['DIDs'],
    summary: 'Register a DID',
    description:
        "Registers a DID the calling tenant acts for, such as a group's (a Bardcast table, a Vox Pop org), so later " +
        "writes can go under it. Antiphony first resolves the DID's document and requires it to name this deployment " +
        'as its space host (`#atproto_space_host`), the same check the app DID passes: 400 `DID_CUSTODY_DISPROVED` ' +
        'if it does not, 503 `DID_UNREACHABLE` if the document cannot be read. A DID belongs to at most one tenant ' +
        '(409 `DID_TAKEN`). Repeating a registration is a no-op (200); changing its role or subject is refused (409 ' +
        '`DID_REGISTERED_DIFFERENTLY`), since records may already be sealed under it. A deployment without ' +
        '`ANTIPHONY_PDS_HOST` cannot check custody and answers 503 `DIDS_UNAVAILABLE`.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        bodyLimit({
            maxSize: 4 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: {
        params: DidParamsSchema,
        body: { content: { 'application/json': { schema: RegisterDidRequestSchema } } },
    },
    responses: {
        200: jsonResponse(TenantDidViewSchema, 'Already registered, unchanged'),
        201: jsonResponse(TenantDidViewSchema, 'Registered'),
        400: errorResponse('Not a DID, the app\'s own DID, or custody disproved (`DID_CUSTODY_DISPROVED`)'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Another tenant\'s DID (`DID_TAKEN`), or registered differently (`DID_REGISTERED_DIFFERENTLY`)'),
        503: errorResponse('The DID document could not be read (`DID_UNREACHABLE`), or custody cannot be checked here (`DIDS_UNAVAILABLE`)'),
    },
});

app.openapi(putRoute, async (c) => {
    const { did } = c.req.valid('param');
    const body = c.req.valid('json');
    const { view, created } = await servicesFor(c.env).didRegistryService.register({
        originAppId: getOriginAppId(c),
        did,
        role: body.role,
        ...(body.subjectRef !== undefined ? { subjectRef: body.subjectRef } : {}),
    });
    return created
        ? c.json({ success: true as const, data: view }, 201)
        : c.json({ success: true as const, data: view }, 200);
});

const getRoute = createRoute({
    method: 'get',
    path: '/{did}',
    tags: ['DIDs'],
    summary: 'Get a registered DID',
    description: "Returns one of the calling tenant's registrations. Another tenant's DID reads as 404.",
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
    ] as const,
    request: { params: DidParamsSchema },
    responses: {
        200: jsonResponse(TenantDidViewSchema, 'The registration'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Not registered by this tenant'),
    },
});

app.openapi(getRoute, async (c) => {
    const { did } = c.req.valid('param');
    const view = await servicesFor(c.env).didRegistryService.get(getOriginAppId(c), did);
    return c.json({ success: true as const, data: view }, 200);
});

const DidPageSchema = z.object({
    items: z.array(TenantDidViewSchema),
    nextCursor: z.string().nullable(),
});

const listRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['DIDs'],
    summary: 'List registered DIDs',
    description: "The calling tenant's registrations, newest first. The app DID is not listed: it is pinned in config.",
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
    ] as const,
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(200).optional().openapi({ description: '1–200 (default 50)' }),
            cursor: z.string().max(2048).optional().openapi({ description: '`nextCursor` from the previous page' }),
        }),
    },
    responses: {
        200: jsonResponse(DidPageSchema, 'One page of registrations'),
        400: errorResponse('Invalid limit or cursor'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(listRoute, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const page = await servicesFor(c.env).didRegistryService.list(getOriginAppId(c), {
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
    });
    return c.json({ success: true as const, data: page }, 200);
});

const deleteRoute = createRoute({
    method: 'delete',
    path: '/{did}',
    tags: ['DIDs'],
    summary: 'Unregister a DID',
    description:
        "Unregisters one of the calling tenant's DIDs, once no post or space is under it: their URIs name the DID, so " +
        'one still in use answers 409 (`DID_IN_USE`). Idempotent: `deleted` is false when there was no such ' +
        'registration, including another tenant\'s.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
    ] as const,
    request: { params: DidParamsSchema },
    responses: {
        200: jsonResponse(z.object({ deleted: z.boolean() }), 'Whether a registration was deleted'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Posts or spaces are still under the DID (`DID_IN_USE`)'),
    },
});

app.openapi(deleteRoute, async (c) => {
    const { did } = c.req.valid('param');
    const deleted = await servicesFor(c.env).didRegistryService.unregister(getOriginAppId(c), did);
    return c.json({ success: true as const, data: { deleted } }, 200);
});

export { app as didsRoute };
