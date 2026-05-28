import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { feedService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/users/:handle/profile
 *
 * Aggregated user-profile-page payload:
 *   `{ profileUser: ProfileView, allPromptsWithReplies: PromptWithReplies[], repliers: Replier[] }`
 *
 * The handle slot accepts a handle or raw UID — `FeedService.getUserProfileData`
 * delegates to `UserService.getUserData` which has the UID fallback. Public
 * endpoint. Returns 404 if the target user can't be resolved.
 *
 * Parity with: apps/web/src/app/api/v1/users/[handle]/profile/route.ts
 *
 * Note: `repliers` is always `[]` in the current implementation — the
 * eager-reply fetch was dropped during Phase 2 simplification. Clients
 * that need repliers call the CRM list endpoint separately.
 */

// Loose schema for the aggregated payload — the sharper view types are
// nested and complex. Acceptable for the pilot; future iterations can
// build a precise `UserProfilePayloadSchema` and lift it into shared.
const ProfilePayloadSchema = z.object({
    profileUser: z.unknown(),
    allPromptsWithReplies: z.array(z.unknown()),
    repliers: z.array(z.unknown()),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const getProfileRoute = createRoute({
    method: 'get',
    path: '/{handle}/profile',
    tags: ['Users'],
    summary: 'Get a user profile page payload',
    description: 'Aggregated payload for the user-profile page: the profile, every public prompt with its replies, and the repliers list.',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The user handle (case-insensitive) or raw UID' }),
        }),
    },
    responses: {
        200: jsonResponse(ProfilePayloadSchema, 'Profile-page payload'),
        404: errorResponse('User not found'),
    },
});

app.openapi(getProfileRoute, async (c) => {
    const handle = c.req.param('handle');
    const data = await feedService.getUserProfileData(handle);

    if (!data) {
        return c.json(errorEnvelope(c, 'User not found'), 404);
    }

    return c.json({ success: true as const, data }, 200);
});

export { app as usersProfileRoute };
