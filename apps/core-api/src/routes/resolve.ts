import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { feedService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/resolve/:handle
 *
 * Resolves a handle string to either a user profile or an organization.
 * The handle space is unified — `@voxpop` could be a user or an org slug —
 * so the endpoint tries users first, then falls back to orgs. Returns
 * `null` (in the envelope's `data`) if neither resolves.
 *
 * Response shape:
 *   { success: true, data: HandleResolution | null }
 *
 * where HandleResolution is:
 *   { type: 'user', profile: ProfileView } | { type: 'org', org: OrganizationView }
 *
 * Public — no auth required. Rate-limited per `RATE_LIMITS.read`.
 *
 * Parity with: apps/web/src/app/api/v1/resolve/[handle]/route.ts
 */

const app = new Hono();

app.get('/:handle', rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');
    const resolution = await feedService.resolveHandle(handle);
    return c.json({
        success: true,
        data: resolution,
    });
});

export { app as resolveRoute };
