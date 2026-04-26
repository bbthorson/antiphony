import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import {
    UpdateReplyStatusRequestSchema,
    BulkReplyActionRequestSchema,
    UpdateAuthorDataRequestSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { replyService, promptService } from '../services/core-services-firebase.js';
import { firebaseReplyDependencies } from '../services/replies-dependencies.js';
import {
    resolvePendingUpload,
    consumePendingUpload,
} from '../lib/pending-uploads.js';
import { logger } from '../lib/logger.js';

/**
 * Reply endpoints mounted at `/api/v1/replies`.
 *
 *   GET   /                         — fetch replies for a prompt (?promptId=).
 *                                     Public; non-author callers get archived
 *                                     prompts' replies hidden.
 *   POST  /                         — create reply; accepts either a direct
 *                                     audioUrl (on-domain) or a pendingUploadId
 *                                     (embed-redirect flow)
 *   PATCH /:replyId/status          — update reply status (live/archived/deleted)
 *   POST  /:replyId/read            — mark reply as read-by-viewer
 *   POST  /:replyId/notes           — update private notes on a reply
 *   POST  /bulk-action              — bulk status / bulk mark-read
 *   POST  /update-author-data       — update author annotations (rating/tags/notes)
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/replies/route.ts (GET + POST)
 *   apps/web/src/app/api/v1/replies/[replyId]/status/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/read/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/notes/route.ts
 *   apps/web/src/app/api/v1/replies/bulk-action/route.ts
 *   apps/web/src/app/api/v1/replies/update-author-data/route.ts
 */

const ListQuerySchema = z.object({
    promptId: z.string().min(1, 'promptId is required'),
    includeArchived: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
});

const NoteSchema = z.object({ notes: z.string().max(5000) });

// POST /replies accepts EITHER a pre-uploaded `audioUrl` (authenticated
// /uploads/audio flow) OR a `pendingUploadId` (embed-redirect flow where
// the iframe uploaded anonymously to /uploads/pending before redirecting
// to this origin). Exactly one must be present.
const CreateReplyRequestSchema = z
    .object({
        // min(1) on id fields — Firestore's `doc('')` throws at ref
        // construction; reject empty strings at the validation boundary.
        promptId: z.string().min(1),
        audioUrl: z.string().url().optional(),
        pendingUploadId: z.string().min(1).optional(),
    })
    .refine((d) => !!d.audioUrl !== !!d.pendingUploadId, {
        message: 'Provide exactly one of audioUrl or pendingUploadId',
    });

const app = new Hono();

// ---------------------------------------------------------------------------
// GET /api/v1/replies?promptId=… — fetch replies for a prompt
// ---------------------------------------------------------------------------
//
// Public endpoint (no requireAuth). Viewer is read via optionalAuth so the
// hydration layer can apply isAuthor-aware projection. Archived prompts'
// replies are hidden from non-authors per ReplyService.getRepliesForPrompt.

app.get('/', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const queryResult = ListQuerySchema.safeParse({
        promptId: c.req.query('promptId'),
        includeArchived: c.req.query('includeArchived'),
    });
    if (!queryResult.success) {
        return c.json(
            {
                status: 'error',
                message: queryResult.error.issues[0]?.message ?? 'Invalid query parameters',
                requestId: c.get('requestId'),
            },
            400,
        );
    }
    const { promptId, includeArchived } = queryResult.data;

    const prompt = await promptService.getPromptData(promptId);
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

    const viewerUid = c.get('viewerUid');
    const isOwner = !!viewerUid && viewerUid === prompt.record.authorId;

    // Visibility gate. apps/web's parity route relies entirely on
    // ReplyService to filter, but its `visibility === 'archived' ? ... : live`
    // mapping never sees `visibility: 'private'` — so private prompts leak
    // their replies to anonymous callers. Mirror prompts.ts:58 instead, which
    // is the correct shape: 404 unless owner OR (status='live' AND public).
    if (!isOwner && (prompt.record.status !== 'live' || prompt.visibility === 'private')) {
        return c.json(
            {
                status: 'error',
                message: 'Prompt not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    // ReplyService.getRepliesForPrompt expects a (record-shape, recipient)
    // pair — extracted from the hydrated PromptView. Use the actual status
    // field directly; `visibility` is a separate concept (public/private)
    // and shouldn't be conflated with status (live/archived/deleted).
    const promptForReplyService = {
        id: prompt.record.id,
        authorId: prompt.author.id,
        status: prompt.record.status,
    };

    const replies = await replyService.getRepliesForPrompt(
        viewerUid ?? '',
        promptForReplyService,
        prompt.author,
        { includeArchived },
    );

    return c.json({
        success: true,
        replies: replies.map(toReplyViewPublic),
    });
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies
// ---------------------------------------------------------------------------

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
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

    const validation = CreateReplyRequestSchema.safeParse(body);
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

    const { promptId, audioUrl: directAudioUrl, pendingUploadId } = validation.data;

    let audioUrl: string;
    if (pendingUploadId) {
        // Embed-redirect: the iframe uploaded to a pending row scoped to
        // promptId. resolvePendingUpload verifies existence, expiry, and
        // prompt-binding. Pending-row deletion happens AFTER reply creation
        // so a transient failure preserves the upload (TTL sweep still
        // catches orphans).
        const pending = await resolvePendingUpload(pendingUploadId, promptId);
        if (!pending) {
            return c.json(
                {
                    status: 'error',
                    message:
                        'Pending upload not found, expired, or does not match this prompt',
                    requestId: c.get('requestId'),
                },
                404,
            );
        }
        audioUrl = pending.audioUrl;
    } else {
        // Refinement guarantees audioUrl is present here.
        audioUrl = directAudioUrl!;
    }

    // createReplyTransaction internally: ensureUserExists(uid) →
    // createReplyWithCounterIncrement → hydrateReply.
    const hydratedReply = await replyService.createReplyTransaction(uid, {
        promptId,
        audioUrl,
    });

    // Best-effort cleanup of the pending row after a successful bind.
    if (pendingUploadId) {
        try {
            await consumePendingUpload(pendingUploadId);
        } catch (err) {
            // consumePendingUpload swallows internally — this catch is
            // defensive in case it evolves to throw.
            logger.error(
                { err, pendingUploadId, requestId: c.get('requestId') },
                '[replies] consumePendingUpload failed',
            );
        }
    }

    return c.json({
        success: true,
        reply: hydratedReply ? toReplyViewPublic(hydratedReply) : null,
    });
});

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
