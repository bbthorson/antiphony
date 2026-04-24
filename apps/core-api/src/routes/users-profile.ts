import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { feedService } from '../services/core-services-firebase.js';

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
 * Response shape: `{ success: true, data: {...} }` or `{ success: false, error }`.
 *
 * Parity with: apps/web/src/app/api/v1/users/[handle]/profile/route.ts
 *
 * Note: `repliers` is always `[]` in the current implementation — the
 * eager-reply fetch was dropped during Phase 2 simplification. Clients
 * that need repliers call the CRM list endpoint separately.
 */

const app = new Hono();

app.get('/:handle/profile', rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');
    const data = await feedService.getUserProfileData(handle);

    if (!data) {
        return c.json({ success: false, error: 'User not found' }, 404);
    }

    return c.json({
        success: true,
        data,
    });
});

export { app as usersProfileRoute };
