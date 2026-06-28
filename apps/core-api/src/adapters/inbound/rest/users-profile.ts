import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ProfileViewBasicSchema, toProfileViewBasic } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { userService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/users/:handle/profile
 *
 * Public actor-profile read for the profile page. Returns the basic
 * (PII-free) profile for the resolved user. The handle slot accepts a handle
 * or raw UID — `UserService.getUserData` carries the UID fallback. Returns
 * 404 if the target user can't be resolved.
 *
 * Identity-only: the canonical Antiphony surface keeps actor records to pure
 * identity. Audio posts and their threads live under `/api/v1/posts`, not on
 * the profile payload.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const getProfileRoute = createRoute({
    method: 'get',
    path: '/{handle}/profile',
    tags: ['Users'],
    summary: 'Get a user profile',
    description: 'Public actor-profile read: the basic (PII-free) profile for the resolved user.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The user handle (case-insensitive) or raw UID' }),
        }),
    },
    responses: {
        200: jsonResponse(ProfileViewBasicSchema, 'Actor profile'),
        404: errorResponse('User not found'),
    },
});

app.openapi(getProfileRoute, async (c) => {
    const handle = c.req.param('handle');
    const profile = await userService.getUserData(handle);

    if (!profile) {
        return c.json(errorEnvelope(c, 'User not found'), 404);
    }

    return c.json({ success: true as const, data: toProfileViewBasic(profile) }, 200);
});

export { app as usersProfileRoute };
