import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { feedService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/organizations/slug/:slug/profile
 *
 * Aggregated org-profile-page payload:
 *   `{ org: OrganizationView, prompts: PromptView[], rssSummary: RssSummary | null }`
 *
 * Returns 404 if the slug doesn't resolve. RSS summary is `null` when the
 * org has no configured feed URL, or when the RSS parse fails (best-effort).
 *
 * Parity with: apps/web/src/app/api/v1/organizations/slug/[slug]/profile/route.ts
 */

const app = new Hono();

app.get('/:slug/profile', rateLimit(RATE_LIMITS.read), async (c) => {
    const slug = c.req.param('slug');
    const data = await feedService.getOrgProfileData(slug);

    if (!data) {
        return c.json({ success: false, error: 'Organization not found' }, 404);
    }

    return c.json({
        success: true,
        data,
    });
});

export { app as organizationsSlugProfileRoute };
