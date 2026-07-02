import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ActorIdentityViewSchema } from 'shared/types/actor-identity';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { actorIdentityService } from '../../outbound/firebase/core-services-firebase.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Actor identity endpoints mounted at `/api/v1/actors` (B4-prep — additive;
 * see `shared/types/actor-identity.ts` for the design rationale).
 *
 *   POST /register     — an app registers the acting actor's DID/handle
 *   GET  /:actorId      — read an actor's registered identity
 *
 * This is NOT the user/profile surface (`/users`, `/atproto`, etc.) — those
 * stay as-is until the BFF cutover lands (see specs/service-auth.md and the
 * migration plan). This is a narrow, new, additive concern: the optional
 * DID mapping a connecting app may register with Antiphony.
 */

const RegisterRequestSchema = z.object({
    /** Display-only handle snapshot. Optional; DID assertion comes from the
     *  X-Antiphony-Acting-Actor-Did header (service-auth), not the body —
     *  that keeps DID trust tied to the auth layer, not client-supplied JSON. */
    handle: z.string().min(1).max(64).optional(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

const registerRoute = createRoute({
    method: 'post',
    path: '/register',
    tags: ['Actors'],
    summary: "Register the acting actor's AT Protocol identity",
    description:
        'An authenticated app registers the DID/handle for the actor it is asserting ' +
        '(`X-Antiphony-Acting-Actor` + optional `X-Antiphony-Acting-Actor-Did` — see specs/service-auth.md). ' +
        'The DID comes from the header assertion, never the body, so trust stays tied to the auth layer. ' +
        'At least one of the header DID or the body `handle` must be present. Merge write: omitting one ' +
        "field leaves the actor's previously registered value for it untouched.",
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: RegisterRequestSchema } },
        },
    },
    responses: {
        200: jsonResponse(ActorIdentityViewSchema, 'Registered identity'),
        400: errorResponse('Neither a DID assertion nor a handle was present, or the DID was malformed'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(registerRoute, async (c) => {
    const actorId = c.get('viewerUid')!;
    const did = c.get('actingActorDid') ?? undefined;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }
    const validation = RegisterRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(errorEnvelope(c, 'Invalid request', { issues: validation.error.issues }), 400);
    }

    const record = await actorIdentityService.registerIdentity(getOriginAppId(c), actorId, {
        did,
        handle: validation.data.handle,
    });

    return c.json({
        success: true as const,
        data: { id: record.id, did: record.did, handle: record.handle },
    }, 200);
});

// ---------------------------------------------------------------------------
// GET /:actorId
// ---------------------------------------------------------------------------

const getRoute = createRoute({
    method: 'get',
    path: '/{actorId}',
    tags: ['Actors'],
    summary: "Get an actor's registered identity",
    description: "Returns the actor's registered DID/handle, scoped to the caller's origin app. Null fields when unregistered.",
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({ actorId: z.string().openapi({ description: 'The actor id' }) }),
    },
    responses: {
        200: jsonResponse(ActorIdentityViewSchema.nullable(), "The actor's identity, or null if unregistered"),
    },
});

app.openapi(getRoute, async (c) => {
    const actorId = c.req.param('actorId');
    const record = await actorIdentityService.getIdentity(getOriginAppId(c), actorId);
    return c.json({
        success: true as const,
        data: record ? { id: record.id, did: record.did, handle: record.handle } : null,
    }, 200);
});

export { app as actorsRoute };
