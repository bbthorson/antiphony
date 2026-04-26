import { Hono } from 'hono';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { feedService } from '../services/core-services-firebase.js';
import { getAdminDb } from '../lib/firebase-admin.js';

/**
 * Top-level people endpoints mounted at `/api/v1/people`.
 *
 *   GET /                  — full People/CRM dashboard data: repliers,
 *                            enrichedRepliers, promptsWithReplies (replies
 *                            projected through `toReplyViewPublic`).
 *   GET /:handle/notes     — per-viewer CRM notes/tags for a given person
 *                            handle. Stored at `users/{uid}/crm/{handle}`.
 *
 * Sibling routes mounted at the same prefix:
 *   - peopleListRoute → GET /list (lightweight enriched-repliers list)
 *   - peopleRepliesRoute → GET /:handle/replies (person-detail feed)
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/people/route.ts (GET /)
 *   apps/web/src/app/api/v1/people/[handle]/notes/route.ts (GET, POST deferred)
 */

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/people — full dashboard data
// ---------------------------------------------------------------------------

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const peopleData = await feedService.getPeopleData(uid);
    if (!peopleData) {
        return c.json(
            { status: 'error', message: 'Not found', requestId: c.get('requestId') },
            404,
        );
    }

    // Strip private CRM fields from replies before sending to the client.
    const sanitizedPromptsWithReplies = peopleData.promptsWithReplies.map((pwr) => ({
        ...pwr,
        replies: pwr.replies.map(toReplyViewPublic),
    }));

    return c.json({
        repliers: peopleData.repliers,
        enrichedRepliers: peopleData.enrichedRepliers,
        promptsWithReplies: sanitizedPromptsWithReplies,
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/people/:handle/notes — viewer's CRM notes for a person
// ---------------------------------------------------------------------------

app.get('/:handle/notes', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    if (!handle || !handle.trim()) {
        // Firestore's `doc('')` throws at ref construction — guard at the
        // boundary so the schema parser can stay simple.
        return c.json(
            { status: 'error', message: 'Invalid handle', requestId: c.get('requestId') },
            400,
        );
    }

    const db = getAdminDb();
    const doc = await db.collection('users').doc(uid).collection('crm').doc(handle).get();

    if (!doc.exists) {
        return c.json({ notes: '', tags: [] });
    }

    const data = doc.data() ?? {};
    return c.json({
        notes: data.notes || '',
        tags: data.tags || [],
    });
});

export { app as peopleRoute };
