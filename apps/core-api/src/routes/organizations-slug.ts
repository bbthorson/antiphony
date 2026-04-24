import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
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
 * **Auth status**: pre-bearer-bridge, `viewerUid` is `undefined`, so
 * `currentUserRole` is never enriched. Matches apps/web's un-authenticated
 * behavior. When the auth bridge lands, pass the viewer uid into
 * `getOrganizationBySlug` to activate role enrichment.
 */

const app = new Hono();

app.get('/:slug', rateLimit(RATE_LIMITS.read), async (c) => {
    const slug = c.req.param('slug');

    // TODO(auth-bridge): read viewer from Authorization header and pass
    // to getOrganizationBySlug to enable currentUserRole enrichment.
    const viewerUid: string | undefined = undefined;
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
