import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { userService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/handles
 *
 * Returns every public handle (doc IDs of the `handles` collection).
 * Used by the sitemap generator to enumerate user profile URLs. Public —
 * no auth required; rate-limited by IP per `RATE_LIMITS.read`.
 *
 * Response shape (matches apps/web's parity endpoint):
 *   { success: true, data: string[] }
 *
 * Parity with: apps/web/src/app/api/v1/handles/route.ts
 */

const app = new Hono();

app.get('/', rateLimit(RATE_LIMITS.read), async (c) => {
    const handles = await userService.getAllPublicHandles();
    return c.json({
        success: true,
        data: handles,
    });
});

export { app as handlesRoute };
