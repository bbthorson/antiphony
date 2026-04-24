import { Hono } from 'hono';
import { toProfileViewBasic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { userService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/users/:handle
 *
 * Returns a user profile with an owner-aware projection:
 *   - Self viewer → full profile (includes PII: email, phone, settings, etc.).
 *   - Everyone else → `ProfileViewBasic` via `toProfileViewBasic` — PII
 *     and admin fields stripped.
 *
 * Handle slot accepts a handle OR a raw UID; `UserService.getUserData`
 * has a UID fallback, so either resolves to the same user.
 *
 * Response shape: `{ success: true, data: ProfileView | ProfileViewBasic }`
 * or `{ success: false, error: 'User not found' }` with status 404.
 *
 * Parity with: apps/web/src/app/api/v1/users/[handle]/route.ts
 *
 * **Auth**: `optionalAuth` attaches the viewer uid from a bearer token
 * if present. Self viewer (`viewer.uid === targetUser.id`) gets the full
 * profile; anyone else (including anonymous) gets `ProfileViewBasic`.
 */

const app = new Hono();

app.get('/:handle', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json({ success: false, error: 'User not found' }, 404);
    }

    const viewerUid = c.get('viewerUid');
    const isSelf = viewerUid !== null && viewerUid === targetUser.id;

    return c.json({
        success: true,
        data: isSelf ? targetUser : toProfileViewBasic(targetUser),
    });
});

export { app as usersRoute };
