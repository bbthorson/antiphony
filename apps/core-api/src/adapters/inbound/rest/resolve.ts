import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ProfileViewBasicSchema, toProfileViewBasic } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { jsonResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/resolve/:handle
 *
 * Resolves a handle string to an actor (user) profile. The handle slot
 * accepts a handle or a raw UID — `UserService.getUserData` carries the
 * UID fallback. Returns `null` (in the envelope's `data`) when the handle
 * resolves to no user.
 *
 * Public identity projection — anonymous, public-safe read. Projects to the
 * *basic* profile shape (no PII; see `ProfileViewBasicSchema`), so it
 * qualifies as a public-projection in the core contract (Plan A, A2).
 *
 * Public — no auth required. Rate-limited per `RATE_LIMITS.read`.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const resolveHandleRoute = createRoute({
    method: 'get',
    path: '/{handle}',
    tags: ['Users'],
    summary: 'Resolve a handle to an actor profile',
    description:
        'Public identity lookup over the handle space. Returns the basic profile (handle, displayName, avatarUrl, bio, opt-in AT Protocol identity) for the resolved actor, or `null` when the handle resolves to no user. The projection omits PII.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The handle to resolve (user handle or raw UID; case-insensitive)' }),
        }),
    },
    responses: {
        200: jsonResponse(ProfileViewBasicSchema.nullable(), 'The resolved actor profile, or null'),
    },
});

app.openapi(resolveHandleRoute, async (c) => {
    const { handle } = c.req.valid('param');
    const profile = await userService.getUserData(handle);
    return c.json({ success: true as const, data: profile ? toProfileViewBasic(profile) : null }, 200);
});

export { app as resolveRoute };
