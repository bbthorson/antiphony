import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { feedService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/people/list
 *
 * Returns the authenticated user's list of repliers — the "People" / CRM
 * view shown in the dashboard. Each entry is an `EnrichedReplier` (a public
 * profile snapshot plus reply counts, first/last reply timestamps, and
 * phone-number lookup for anonymous phone repliers).
 *
 * Auth-required — owner is the viewer; no cross-user queries.
 *
 * Query params:
 *   - `orgId` (optional) — scope to an org context. Empty / missing = personal.
 *
 * Response: `{ success: true, data: EnrichedReplier[] }`
 *
 * Parity with: apps/web/src/app/api/v1/people/list/route.ts
 */

const QuerySchema = z.object({
    // Empty string is treated as "personal context" (null) — matches the
    // apps/web parity handler's `orgIdRaw && orgIdRaw.length > 0` check.
    orgId: z
        .string()
        .optional()
        .transform((v) => (v && v.length > 0 ? v : null)),
});

const app = new Hono();

app.get('/list', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const queryResult = QuerySchema.safeParse({
        orgId: c.req.query('orgId'),
    });
    if (!queryResult.success) {
        return c.json(
            { success: false, error: 'Invalid query parameters', issues: queryResult.error.issues },
            400,
        );
    }
    const { orgId } = queryResult.data;

    const enrichedRepliers = await feedService.getPeopleList(uid, orgId);

    return c.json({
        success: true,
        data: enrichedRepliers,
    });
});

export { app as peopleListRoute };
