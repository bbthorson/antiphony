import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { feedService } from '../../outbound/firebase/core-services-firebase.js';

/**
 * People / CRM endpoints mounted at `/api/v1/people`.
 *
 *   GET /list  — list authenticated user's repliers (EnrichedReplier[]).
 *
 * Parity source:
 *   apps/web/src/app/api/v1/people/list/route.ts
 */

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/people/list?orgId=...
// ---------------------------------------------------------------------------
//
// Returns the authenticated user's list of repliers (the "People" / CRM view).
// Each entry is an `EnrichedReplier`. Auth-required; endpoint derives the
// owner from the session — no cross-user queries.
//
// Query params:
//   orgId (optional) — scope to an org context. Missing/empty = personal.

app.get('/list', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const orgIdRaw = c.req.query('orgId');
    // Treat missing or empty as null (personal context). Matches the service
    // signature's `orgId?: string | null`.
    const orgId = orgIdRaw && orgIdRaw.length > 0 ? orgIdRaw : null;

    const enrichedRepliers = await feedService.getPeopleList(uid, orgId);

    return c.json({ success: true, data: enrichedRepliers });
});

export { app as peopleRoute };
