import { Hono } from 'hono';
import { toProfileViewBasic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
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
 * **Auth status**: pre-bearer-bridge, `viewerUid = null`, so `isSelf` is
 * always false and all responses go through `toProfileViewBasic`. Matches
 * apps/web's behavior on an un-authenticated request. When the auth
 * bridge PR lands, flip `viewerUid` to activate the self-view branch.
 */

const app = new Hono();

app.get('/:handle', rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json({ success: false, error: 'User not found' }, 404);
    }

    // TODO(auth-bridge): read viewer from Authorization header.
    const viewerUid: string | null = null;
    const isSelf = viewerUid !== null && viewerUid === targetUser.id;

    return c.json({
        success: true,
        data: isSelf ? targetUser : toProfileViewBasic(targetUser),
    });
});

export { app as usersRoute };
