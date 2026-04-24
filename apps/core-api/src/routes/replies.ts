import { Hono } from 'hono';
import { z } from 'zod';
import {
    UpdateReplyStatusRequestSchema,
    BulkReplyActionRequestSchema,
    UpdateAuthorDataRequestSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { replyService, promptService } from '../services/core-services-firebase.js';
import { firebaseReplyDependencies } from '../services/replies-dependencies.js';

/**
 * Reply-write endpoints mounted at `/api/v1/replies`. Auth-gated across the
 * board; ownership enforced via the reply's parent prompt.
 *
 * Coverage in this PR (Batch A4):
 *   PATCH /:replyId/status          — update reply status (live/archived/deleted)
 *   POST  /:replyId/read            — mark reply as read-by-viewer
 *   POST  /:replyId/notes           — update private notes on a reply
 *   POST  /bulk-action              — bulk status / bulk mark-read
 *   POST  /update-author-data       — update author annotations (rating/tags/notes)
 *
 * Not in this PR:
 *   POST /                          — create reply (requires pending-uploads
 *                                     port + ensureUserExists wire; A4.2)
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/replies/[replyId]/status/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/read/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/notes/route.ts
 *   apps/web/src/app/api/v1/replies/bulk-action/route.ts
 *   apps/web/src/app/api/v1/replies/update-author-data/route.ts
 */

const NoteSchema = z.object({ notes: z.string().max(5000) });

const app = new Hono();

// ---------------------------------------------------------------------------
// PATCH /api/v1/replies/:replyId/status
// ---------------------------------------------------------------------------

app.patch('/:replyId/status', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const replyId = c.req.param('replyId');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = UpdateReplyStatusRequestSchema.safeParse(body);
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

    // ReplyService.updateReplyStatus throws NotFoundError / ForbiddenError —
    // both ServiceError subclasses, mapped to 404/403 by the error-handler.
    await replyService.updateReplyStatus(replyId, validation.data.status, uid);

    return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/:replyId/read
// ---------------------------------------------------------------------------

app.post('/:replyId/read', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const replyId = c.req.param('replyId');

    // Parity with apps/web: no ownership check — `readBy` is a non-sensitive
    // tracking field and the direct Firestore update is idempotent
    // (arrayUnion). Routed through the binding (rather than raw getAdminDb)
    // so the write stays behind the dep-layer seam.
    await firebaseReplyDependencies.markReplyRead(replyId, uid);

    return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/:replyId/notes
// ---------------------------------------------------------------------------
//
// apps/web's parity route uses PATCH; keeping POST here for consistency with
// the path spec in the migration plan ("POST /replies/:id/notes"). Both verbs
// are acceptable per REST conventions for an update-or-set operation.

app.post('/:replyId/notes', requireAuth(), rateLimit(RATE_LIMITS.hourly), async (c) => {
    const uid = c.get('viewerUid')!;
    const replyId = c.req.param('replyId');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = NoteSchema.safeParse(body);
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

    const reply = await replyService.getReplyRecord(replyId);
    if (!reply) {
        return c.json(
            {
                status: 'error',
                message: 'Reply not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const prompt = await promptService.getPromptRecord(reply.promptId);
    if (!prompt) {
        return c.json(
            {
                status: 'error',
                message: 'Prompt not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    if (prompt.authorId !== uid) {
        return c.json(
            {
                status: 'error',
                message: 'Forbidden',
                requestId: c.get('requestId'),
            },
            403,
        );
    }

    await replyService.updateReplyNotes(replyId, validation.data.notes);

    return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/bulk-action
// ---------------------------------------------------------------------------

app.post('/bulk-action', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = BulkReplyActionRequestSchema.safeParse(body);
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

    const { replyIds, action } = validation.data;

    switch (action) {
        case 'markRead':
            await replyService.bulkMarkRead(replyIds, uid);
            break;
        case 'archive':
            await replyService.bulkUpdateStatus(replyIds, 'archived', uid);
            break;
        case 'delete':
            await replyService.bulkUpdateStatus(replyIds, 'deleted', uid);
            break;
        case 'restore':
            await replyService.bulkUpdateStatus(replyIds, 'live', uid);
            break;
    }

    return c.json({ status: 'success', count: replyIds.length });
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/update-author-data
// ---------------------------------------------------------------------------

app.post('/update-author-data', requireAuth(), rateLimit(RATE_LIMITS.hourly), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(
            {
                status: 'error',
                message: 'Invalid JSON body',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const validation = UpdateAuthorDataRequestSchema.safeParse(body);
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

    const { replyId, data } = validation.data;

    const replyRecord = await replyService.getReplyRecord(replyId);
    if (!replyRecord) {
        return c.json(
            {
                status: 'error',
                message: `Reply with ID ${replyId} not found.`,
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const promptRecord = await promptService.getPromptRecord(replyRecord.promptId);
    if (!promptRecord) {
        return c.json(
            {
                status: 'error',
                message: 'Parent prompt not found.',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    if (promptRecord.authorId !== uid) {
        return c.json(
            {
                status: 'error',
                message: 'Forbidden: You do not own the prompt for this reply.',
                requestId: c.get('requestId'),
            },
            403,
        );
    }

    // Route through the deps layer rather than reaching for getAdminDb from
    // the route handler (as apps/web does). The validated `data` is already a
    // Partial<ReplyRecord> — no coercion needed.
    await firebaseReplyDependencies.updateReply(replyId, data);

    return c.json({ status: 'success' });
});

export { app as repliesRoute };
