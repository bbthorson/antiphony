import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { userService, organizationService } from '../services/core-services-firebase.js';

/**
 * Authenticated-viewer "me" endpoints. Mounts at `/api/v1/users/me` so these
 * paths win the match over `/api/v1/users/:handle` — the app.ts mount order
 * registers this route file before `usersRoute` so Hono prefers the more
 * specific prefix.
 *
 * GET /api/v1/users/me
 *   Returns the authenticated user's full profile (PII included). Mirrors
 *   apps/web's parity endpoint which returns the raw ProfileView (no
 *   `{ success, data }` envelope), so we do the same here for client parity.
 *
 * GET /api/v1/users/me/organizations
 *   Returns the full list of hydrated OrganizationViews the viewer is a
 *   member of. Response shape: `{ success: true, data: OrganizationView[] }`.
 *
 * Parity with:
 *   apps/web/src/app/api/v1/users/me/route.ts
 *   apps/web/src/app/api/v1/users/me/organizations/route.ts
 */

const app = new Hono();

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const profile = await userService.getUserDataByUid(uid);
    if (!profile) {
        return c.json(
            {
                status: 'error',
                message: 'Profile not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }
    return c.json(profile);
});

app.get('/organizations', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgs = await organizationService.getUserOrganizations(uid);
    return c.json({
        success: true,
        data: orgs,
    });
});

export { app as usersMeRoute };
