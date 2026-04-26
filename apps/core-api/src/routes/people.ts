import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { feedService } from '../services/core-services-firebase.js';
import { getAdmin, getAdminDb } from '../lib/firebase-admin.js';

/**
 * Top-level people endpoints mounted at `/api/v1/people`.
 *
 *   GET  /                  — full People/CRM dashboard data: repliers,
 *                             enrichedRepliers, promptsWithReplies (replies
 *                             projected through `toReplyViewPublic`).
 *   GET  /:handle/notes     — per-viewer CRM notes/tags for a given person
 *                             handle. Stored at `users/{uid}/crm/{handle}`.
 *   POST /:handle/notes     — update CRM notes/tags for a given person.
 *
 * Sibling routes mounted at the same prefix:
 *   - peopleListRoute → GET /list (lightweight enriched-repliers list)
 *   - peopleRepliesRoute → GET /:handle/replies (person-detail feed)
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/people/route.ts (GET /)
 *   apps/web/src/app/api/v1/people/[handle]/notes/route.ts (GET + POST)
 */

const NotesUpdateSchema = z.object({
    notes: z.string().max(5000).optional(),
    tags: z.array(z.string().max(60)).max(50).optional(),
});

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

// ---------------------------------------------------------------------------
// POST /api/v1/people/:handle/notes — update viewer's CRM notes/tags
// ---------------------------------------------------------------------------

app.post('/:handle/notes', requireAuth(), rateLimit(RATE_LIMITS.burst), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    if (!handle || !handle.trim()) {
        return c.json(
            { status: 'error', message: 'Invalid handle', requestId: c.get('requestId') },
            400,
        );
    }

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            { status: 'error', message: 'Invalid JSON', requestId: c.get('requestId') },
            400,
        );
    }

    const validation = NotesUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid request body',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    // Mirror apps/web's behavior: only set fields that were provided. The
    // merge: true write means undefined fields stay untouched on the doc.
    // Uses FieldValue.serverTimestamp() (vs apps/web's Timestamp.now()) so
    // Firestore stamps the time on its own clock — avoids skew between the
    // request-handling instance and the database.
    const update: Record<string, unknown> = {
        lastUpdated: getAdmin().firestore.FieldValue.serverTimestamp(),
    };
    if (validation.data.notes !== undefined) update.notes = validation.data.notes;
    if (validation.data.tags !== undefined) update.tags = validation.data.tags;

    const db = getAdminDb();
    await db
        .collection('users')
        .doc(uid)
        .collection('crm')
        .doc(handle)
        .set(update, { merge: true });

    return c.json({ success: true });
});

export { app as peopleRoute };
