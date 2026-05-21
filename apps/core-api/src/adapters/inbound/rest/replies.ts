import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import {
    UpdateReplyStatusRequestSchema,
    BulkReplyActionRequestSchema,
} from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { replyService, promptService, hydrationService } from '../../outbound/firebase/core-services-firebase.js';
import { firebaseReplyDependencies } from '../../outbound/firebase/replies-dependencies.js';
import {
    resolvePendingUpload,
    consumePendingUpload,
} from '../../../lib/pending-uploads.js';
import { logger } from '../../../lib/logger.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * Reply endpoints mounted at `/api/v1/replies`.
 *
 *   GET   /                         — fetch replies for a prompt (?promptId=).
 *                                     Public; non-author callers get archived
 *                                     prompts' replies hidden.
 *   GET   /:replyId                 — single reply lookup (auth required).
 *                                     Returns ReplyViewPublic; gates parent
 *                                     prompt visibility same as GET /.
 *   POST  /                         — create reply; accepts either a direct
 *                                     audioUrl (on-domain) or a pendingUploadId
 *                                     (embed-redirect flow)
 *   PATCH /:replyId/status          — update reply status (live/archived/deleted)
 *   POST  /:replyId/read            — mark reply as read-by-viewer
 *   PATCH /:replyId/notes           — update private notes on a reply
 *   POST  /bulk-action              — bulk status / bulk mark-read
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/replies/route.ts (GET + POST)
 *   apps/web/src/app/api/v1/replies/[replyId]/status/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/read/route.ts
 *   apps/web/src/app/api/v1/replies/[replyId]/notes/route.ts
 *   apps/web/src/app/api/v1/replies/bulk-action/route.ts
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
            errorEnvelope(c, queryResult.error.issues[0]?.message ?? 'Invalid query parameters'),
            400,
        );
    }
    const { promptId, includeArchived } = queryResult.data;

    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    const viewerUid = c.get('viewerUid');
    const isOwner = !!viewerUid && viewerUid === prompt.record.authorId;

    // Visibility gate. apps/web's parity route relies entirely on
    // ReplyService to filter, but its `visibility === 'archived' ? ... : live`
    // mapping never sees `visibility: 'private'` — so private prompts leak
    // their replies to anonymous callers. Mirror prompts.ts:58 instead, which
    // is the correct shape: 404 unless owner OR (status='live' AND public).
    if (!isOwner && (prompt.record.status !== 'live' || prompt.visibility === 'private')) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
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
        data: replies.map(toReplyViewPublic),
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/replies/:replyId — single-reply lookup
// ---------------------------------------------------------------------------
//
// Powers deep-link recovery in the Replies tab: when the URL carries a
// `?replyId=<id>` that lives past the currently loaded feed page(s), the UI
// fetches the single reply via this endpoint and uses it as the detail-pane
// fallback. Requires auth (the inbox is a logged-in surface), and gates
// visibility with the same rules GET / uses:
//
//   - Owner of the parent prompt → 200.
//   - Non-owner, prompt is live AND public → 200 (parity with GET / which
//     exposes replies of public-live prompts to anonymous viewers; this
//     endpoint stays consistent so embed-like flows can deep-link too).
//   - Non-owner, prompt archived/deleted/draft → 404 (mask existence; matches
//     the GET / handler's non-live → 404 branch).
//   - Non-owner, prompt is live but private/unlisted → 403 (the prompt is
//     visible-by-link to its author elsewhere; a clearer error than 404 here
//     since the caller is auth'd and we can attribute the denial).

app.get('/:replyId', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const replyId = c.req.param('replyId');

    const record = await replyService.getReplyRecord(replyId);
    if (!record) {
        return c.json(errorEnvelope(c, 'Reply not found'), 404);
    }

    const prompt = await promptService.getPromptData(record.promptId);
    if (!prompt) {
        return c.json(errorEnvelope(c, 'Reply not found'), 404);
    }

    const isOwner = uid === prompt.record.authorId;
    if (!isOwner) {
        // Archived/deleted/draft → mask existence with 404, same as GET /.
        if (prompt.record.status !== 'live') {
            return c.json(errorEnvelope(c, 'Reply not found'), 404);
        }
        // Live but private/unlisted — caller is auth'd, so 403 is the more
        // honest answer.
        if (prompt.visibility !== 'public') {
            return c.json(errorEnvelope(c, 'Forbidden'), 403);
        }
    }

    // Hydrate against the resolved recipient (parent prompt's author) so we
    // skip the loader's prompt-lookup leg — we already have it.
    const view = await hydrationService.hydrateReply(record, prompt.author);
    if (!view) {
        // Orphaned (missing recipient) — surfaces same as not-found.
        return c.json(errorEnvelope(c, 'Reply not found'), 404);
    }

    return c.json({ success: true, data: toReplyViewPublic(view) });
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
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CreateReplyRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
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
                errorEnvelope(c, 'Pending upload not found, expired, or does not match this prompt'),
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
        data: hydratedReply ? toReplyViewPublic(hydratedReply) : null,
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
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = UpdateReplyStatusRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    // ReplyService.updateReplyStatus throws NotFoundError / ForbiddenError —
    // both ServiceError subclasses, mapped to 404/403 by the error-handler.
    await replyService.updateReplyStatus(replyId, validation.data.status, uid);

    return c.json({ success: true, data: null });
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

    // `data: null` — fire-and-forget op with no resource to return. The
    // null keeps the response on the standard `{success, data}` envelope
    // so callers (including `apiClient.postData`) can use the unwrap helper.
    return c.json({ success: true, data: null });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/replies/:replyId/notes
// ---------------------------------------------------------------------------
//
// PATCH matches apps/web's parity route. Originally core-api also exposed a
// POST verb alias for parity with an earlier migration spec, but no caller
// ever used it; removed 2026-04-26 to reduce surface (audit finding from
// specs/api-ledger.md).

const handleNotesUpdate = async (c: Context) => {
    const uid = c.get('viewerUid')!;
    const replyId = c.req.param('replyId')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = NoteSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
            400,
        );
    }

    const reply = await replyService.getReplyRecord(replyId);
    if (!reply) {
        return c.json(errorEnvelope(c, 'Reply not found'), 404);
    }

    const prompt = await promptService.getPromptRecord(reply.promptId);
    if (!prompt) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    if (prompt.authorId !== uid) {
        return c.json(errorEnvelope(c, 'Forbidden'), 403);
    }

    await replyService.updateReplyNotes(replyId, validation.data.notes);

    // `data: null` — see comment on /replies/:replyId/read above.
    return c.json({ success: true, data: null });
};

app.patch('/:replyId/notes', requireAuth(), rateLimit(RATE_LIMITS.hourly), handleNotesUpdate);

// ---------------------------------------------------------------------------
// POST /api/v1/replies/bulk-action
// ---------------------------------------------------------------------------

app.post('/bulk-action', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = BulkReplyActionRequestSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid request body', { issues: validation.error.issues }),
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

    // Drop the `count` echo — caller computes it from request input.
    // `data: null` keeps the standard envelope.
    return c.json({ success: true, data: null });
});

export { app as repliesRoute };
