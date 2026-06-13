import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toReplyViewPublic, ReplyViewPublicSchema } from 'shared/types/views';
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
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

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
 * Validation note: each route declares its full Zod request schema in
 * `createRoute({ request })`. The OpenAPIHono validator parses inbound
 * requests against the schema and the handler accesses validated data
 * via `c.req.valid('query' | 'json' | 'param')`. No second `safeParse`
 * in the handler.
 */

const ListQuerySchema = z.object({
    promptId: z.string().min(1, 'promptId is required').openapi({ description: 'The parent prompt id' }),
    includeArchived: z
        .string()
        .optional()
        .transform((v) => v === 'true')
        .openapi({ description: 'When `"true"`, include archived replies (only honored for owner views)' }),
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

const ReplyIdParamSchema = z.object({
    replyId: z.string().openapi({ description: 'The reply id' }),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET /api/v1/replies?promptId=… — fetch replies for a prompt
// ---------------------------------------------------------------------------

const listRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Replies'],
    summary: 'List replies for a prompt',
    description: 'Returns the public projection (`ReplyViewPublic[]`) of replies for the given prompt. Anonymous-friendly; the parent prompt\'s visibility + status gates non-author access.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { query: ListQuerySchema },
    responses: {
        200: jsonResponse(z.array(ReplyViewPublicSchema), 'Replies on the prompt'),
        400: errorResponse('Invalid query parameters'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(listRoute, async (c) => {
    const { promptId, includeArchived } = c.req.valid('query');

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
        success: true as const,
        data: replies.map(toReplyViewPublic),
    }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/replies/:replyId — single-reply lookup
// ---------------------------------------------------------------------------

const getByIdRoute = createRoute({
    method: 'get',
    path: '/{replyId}',
    tags: ['Replies'],
    summary: 'Get a reply by id',
    description: 'Returns the public projection of a single reply. Owners see their own replies regardless of parent-prompt status; non-owners see only replies on live + public prompts (404 for archived/draft, 403 for live + private).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { params: ReplyIdParamSchema },
    responses: {
        200: jsonResponse(ReplyViewPublicSchema, 'Reply'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Parent prompt is private'),
        404: errorResponse('Reply not found'),
    },
});

app.openapi(getByIdRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { replyId } = c.req.valid('param');

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

    return c.json({ success: true as const, data: toReplyViewPublic(view) }, 200);
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies
// ---------------------------------------------------------------------------

const createRouteDef = createRoute({
    method: 'post',
    path: '/',
    tags: ['Replies'],
    summary: 'Create a reply',
    description: 'Creates a reply on a prompt. The audio source is either a pre-uploaded `audioUrl` (authenticated upload flow) or a `pendingUploadId` (embed-redirect flow). Exactly one is required.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: CreateReplyRequestSchema } },
            required: true,
        },
    },
    responses: {
        200: jsonResponse(ReplyViewPublicSchema.nullable(), 'The hydrated reply (null if hydration failed)'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Pending upload not found or expired'),
    },
});

app.openapi(createRouteDef, async (c) => {
    const uid = c.get('viewerUid')!;
    const { promptId, audioUrl: directAudioUrl, pendingUploadId } = c.req.valid('json');

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
        success: true as const,
        data: hydratedReply ? toReplyViewPublic(hydratedReply) : null,
    }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/replies/:replyId/status
// ---------------------------------------------------------------------------

const updateStatusRoute = createRoute({
    method: 'patch',
    path: '/{replyId}/status',
    tags: ['Replies'],
    summary: 'Update a reply\'s status',
    description: 'Flips a reply\'s status (`live` / `archived` / `deleted`). Author of the parent prompt only.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: ReplyIdParamSchema,
        body: {
            content: { 'application/json': { schema: UpdateReplyStatusRequestSchema } },
            required: true,
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Status updated'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
        404: errorResponse('Reply not found'),
    },
});

app.openapi(updateStatusRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { replyId } = c.req.valid('param');
    const { status } = c.req.valid('json');

    // ReplyService.updateReplyStatus throws NotFoundError / ForbiddenError —
    // both ServiceError subclasses, mapped to 404/403 by the error-handler.
    await replyService.updateReplyStatus(replyId, status, uid);

    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/:replyId/read
// ---------------------------------------------------------------------------

const markReadRoute = createRoute({
    method: 'post',
    path: '/{replyId}/read',
    tags: ['Replies'],
    summary: 'Mark a reply as read by the viewer',
    description: 'Adds the viewer\'s uid to the reply\'s `readBy` set. Idempotent; no ownership check (matches `POST /prompts/:id/read`).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: { params: ReplyIdParamSchema },
    responses: {
        200: jsonResponse(z.null(), 'Reply marked read'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(markReadRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { replyId } = c.req.valid('param');

    // Parity with apps/web: no ownership check — `readBy` is a non-sensitive
    // tracking field and the direct Firestore update is idempotent
    // (arrayUnion). Routed through the binding (rather than raw getAdminDb)
    // so the write stays behind the dep-layer seam.
    await firebaseReplyDependencies.markReplyRead(replyId, uid);

    // `data: null` — fire-and-forget op with no resource to return. The
    // null keeps the response on the standard `{success, data}` envelope
    // so callers (including `apiClient.postData`) can use the unwrap helper.
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/replies/:replyId/notes
// ---------------------------------------------------------------------------
//
// PATCH matches apps/web's parity route. Originally core-api also exposed a
// POST verb alias for parity with an earlier migration spec, but no caller
// ever used it; removed 2026-04-26 to reduce surface (audit finding from
// specs/api-ledger.md).

const updateNotesRoute = createRoute({
    method: 'patch',
    path: '/{replyId}/notes',
    tags: ['Replies'],
    summary: 'Update private CRM notes on a reply',
    description: 'Author-of-parent-prompt only. The notes live on the enrichments doc (`enrichments/replies/items/{id}`) and never appear in the public projection.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.hourly)] as const,
    request: {
        params: ReplyIdParamSchema,
        body: {
            content: { 'application/json': { schema: NoteSchema } },
            required: true,
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Notes updated'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
        404: errorResponse('Reply or prompt not found'),
    },
});

app.openapi(updateNotesRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { replyId } = c.req.valid('param');
    const { notes } = c.req.valid('json');

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

    await replyService.updateReplyNotes(replyId, notes);

    // `data: null` — see comment on /replies/:replyId/read above.
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// POST /api/v1/replies/bulk-action
// ---------------------------------------------------------------------------

const bulkActionRoute = createRoute({
    method: 'post',
    path: '/bulk-action',
    tags: ['Replies'],
    summary: 'Bulk-apply an action to a list of replies',
    description: 'Apply `markRead`, `archive`, `delete`, or `restore` to a batch of reply ids. Status mutations require ownership of the parent prompt; `markRead` is idempotent and unowned.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        body: {
            content: { 'application/json': { schema: BulkReplyActionRequestSchema } },
            required: true,
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Bulk action completed'),
        400: errorResponse('Invalid request body'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
    },
});

app.openapi(bulkActionRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { replyIds, action } = c.req.valid('json');

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
    return c.json({ success: true as const, data: null }, 200);
});

export { app as repliesRoute };
