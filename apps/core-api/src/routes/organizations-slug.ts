import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { organizationService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/organizations/slug/:slug
 *
 * Resolves an organization by its public slug, hydrated as an
 * `OrganizationView`. Public endpoint — auth is optional. When a viewer
 * is authenticated, `currentUserRole` on the returned view reflects that
 * user's membership role.
 *
 * Response shape: `{ success: true, data: OrganizationView }` or
 * `{ success: false, error: 'Organization not found' }` with status 404.
 *
 * Parity with: apps/web/src/app/api/v1/organizations/slug/[slug]/route.ts
 *
 * **Auth**: `optionalAuth` attaches the viewer uid if a bearer token is
 * present. Forwarded to `getOrganizationBySlug` so the service can
 * enrich `currentUserRole` for members of the org.
 */

const app = new Hono();

app.get('/:slug', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const slug = c.req.param('slug');

    // `viewerUid` is string | null from the middleware; the service's
    // second arg is `currentUserId?: string`, so `null → undefined`.
    const viewerUid = c.get('viewerUid') ?? undefined;
    const org = await organizationService.getOrganizationBySlug(slug, viewerUid);

    if (!org) {
        return c.json({ success: false, error: 'Organization not found' }, 404);
    }

    return c.json({
        success: true,
        data: org,
    });
});

export { app as organizationsSlugRoute };
