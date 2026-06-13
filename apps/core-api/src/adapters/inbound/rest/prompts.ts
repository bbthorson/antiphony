import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toPromptViewPublic, PromptViewSchema, PromptViewPublicSchema } from 'shared/types/views';
import { CreatePromptRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import {
    promptService,
    organizationService,
} from '../../outbound/firebase/core-services-firebase.js';
import { firebaseReplyDependencies } from '../../outbound/firebase/replies-dependencies.js';
import {
    checkIdempotency,
    saveIdempotencyResult,
    IdempotencyInProgressError,
} from '../../../lib/idempotency.js';
import { logger } from '../../../lib/logger.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Prompt endpoints mounted at `/api/v1/prompts`.
 *
 *   GET    /                     — list authenticated viewer's prompts (paginated)
 *   GET    /:promptId            — owner-aware PromptView (optional auth)
 *   POST   /                     — create prompt (idempotency-capable)
 *   PATCH  /:promptId/status     — update status (live/archived)
 *   PATCH  /:promptId/atproto-uri — record the at:// URI after publish
 *   DELETE /:promptId            — soft-delete (status -> deleted)
 *   POST   /:promptId/read       — mark all replies for the prompt as read
 *
 * OpenAPI metadata declared on every route — sub-PR 2 of the OpenAPI
 * generation series per `specs/drafts/openapi-generation.md`. Handler
 * bodies preserve their existing manual validation; the `createRoute`
 * wrapper documents the shape.
 *
 * **Ownership model** (for writes): the prompt's `authorId` is the owner.
 * Org members can also act on the prompt if the author is an org — this
 * mirrors apps/web's `isMember(authorId, uid)` check, which treats the
 * author field as either a user id or an org id.
 */

const StatusUpdateSchema = z.object({ status: z.enum(['live', 'archived']) });

const AtprotoUriUpdateSchema = z.object({
    atprotoUri: z.string().regex(/^at:\/\/.+/, 'Must be an at:// URI'),
});

const ListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
});

const ListResponseSchema = z.object({
    items: z.array(PromptViewSchema),
    nextCursor: z.string().nullable(),
});

const CreateResponseSchema = z.object({ promptId: z.string() });

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET / — list viewer's prompts (paginated)
// ---------------------------------------------------------------------------

const listRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Prompts'],
    summary: 'List the authenticated viewer\'s prompts',
    description: 'Paginated list of prompts authored by the authenticated viewer. Cursor-paginated by prompt id.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 20)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last prompt id from the prior page' }),
        }),
    },
    responses: {
        200: jsonResponse(ListResponseSchema, 'Paginated list of the viewer\'s prompts'),
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(listRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    const queryResult = ListQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
    });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { limit, cursor } = queryResult.data;

    const prompts = await promptService.getPromptsForUser(uid, limit, cursor);

    // Paginated standard shape: cursor lives INSIDE `data` alongside
    // `items`. Same `{ success, data: { items, nextCursor } }` envelope
    // used by /replies/feed, /users, and the other paginated endpoints
    // post envelope-Phase-3.
    return c.json({
        success: true as const,
        data: {
            items: prompts,
            // Only set a cursor when the page is full AND non-empty —
            // guards against `prompts[-1]` on empty pages.
            nextCursor:
                prompts.length > 0 && prompts.length === limit
                    ? prompts[prompts.length - 1].record.id
                    : null,
        },
    }, 200);
});

// ---------------------------------------------------------------------------
// GET /:promptId
// ---------------------------------------------------------------------------

const getByIdRoute = createRoute({
    method: 'get',
    path: '/{promptId}',
    tags: ['Prompts'],
    summary: 'Get a prompt by id',
    description: 'Returns the prompt. The owner sees the full `PromptView` (including author-private CRM state); non-owners and anonymous viewers see `PromptViewPublic`. Non-live prompts visible only to the owner.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
    },
    responses: {
        200: jsonResponse(z.union([PromptViewSchema, PromptViewPublicSchema]), 'Prompt (owner-aware projection)'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(getByIdRoute, async (c) => {
    const promptId = c.req.param('promptId');
    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    const viewerUid = c.get('viewerUid');
    const isOwner = viewerUid !== null && viewerUid === prompt.record.authorId;

    if (!isOwner && (prompt.record.status !== 'live' || prompt.visibility === 'private')) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    return c.json({
        success: true as const,
        data: isOwner ? prompt : toPromptViewPublic(prompt),
    }, 200);
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------

const createRouteDef = createRoute({
    method: 'post',
    path: '/',
    tags: ['Prompts'],
    summary: 'Create a prompt',
    description: 'Creates a prompt authored by the viewer (or by the active org if `currentOrg` is set on the session). Supports the `Idempotency-Key` request header for safe retries.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        headers: z.object({
            'idempotency-key': z.string().optional().openapi({ description: 'Optional idempotency key — repeated requests with the same key return the cached response.' }),
        }),
        body: {
            content: { 'application/json': { schema: CreatePromptRequestSchema } },
        },
    },
    responses: {
        200: jsonResponse(CreateResponseSchema, 'Prompt created'),
        400: errorResponse('Validation failed'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not a member of the active organization'),
        409: errorResponse('Idempotency conflict — prior request still in flight'),
    },
});

app.openapi(createRouteDef, async (c) => {
    const uid = c.get('viewerUid')!;
    const session = c.get('viewerSession');

    // `currentOrg` lives on the session as a custom claim — matches apps/web's
    // protectedRouteWithOrg shape (set at org-switch time).
    const currentOrg = (session?.currentOrg ?? null) as string | null;

    if (currentOrg) {
        const isMember = await organizationService.isMember(currentOrg, uid);
        if (!isMember) {
            return c.json(errorEnvelope(c, 'Not a member of active organization'), 403);
        }
    }

    // Idempotency: if the client retries with the same Idempotency-Key, we
    // either return the cached response (completed) or 409 (still processing).
    // The uid is threaded in so the doc ID is per-user — two different callers
    // with the same raw key get independent records (M5 security fix).
    try {
        const idem = await checkIdempotency(c, uid);
        if (idem) {
            return c.json(idem.cached as object, 200);
        }
    } catch (err) {
        if (err instanceof IdempotencyInProgressError) {
            return c.json(errorEnvelope(c, err.message), 409);
        }
        throw err;
    }

    // Body parsing. JSON-only — multipart was dropped in PR #413 (hexagonal
    // refactor) on the assumption that apps/web had migrated to JSON. The
    // dashboard's `use-prompt-creation.ts` was still sending FormData
    // through 2026-05-26; that broke every prompt create with 400
    // "Invalid JSON body" until the client switched to
    // `authenticatedApi.postData` (this commit's companion fix).
    let rawData: unknown;
    try {
        rawData = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CreatePromptRequestSchema.safeParse(rawData);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Validation failed', { issues: validation.error.issues }),
            400,
        );
    }

    const { title, description, audioUrl, setAsGreeting } = validation.data;

    const created = await promptService.validateAndCreatePrompt({
        title,
        description: description || '',
        audioUrl,
        authorId: uid,
        orgId: currentOrg,
        createdBy: uid,
    });

    // Set-as-greeting updates the user's "General Inbox" prompt (id
    // `inbox_{uid}`) with the new audio. Best-effort — failures log and
    // the create still succeeds.
    if (setAsGreeting) {
        const inboxId = `inbox_${uid}`;
        try {
            await promptService.updatePrompt(inboxId, { audioUrl });
        } catch (err) {
            logger.error(
                { err, requestId: c.get('requestId'), inboxId },
                '[prompts] setAsGreeting: failed to update inbox prompt',
            );
        }
    }

    const responseBody = { success: true as const, data: { promptId: created.id } };
    await saveIdempotencyResult(c, uid, responseBody);

    return c.json(responseBody, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:promptId/status
// ---------------------------------------------------------------------------

const updateStatusRoute = createRoute({
    method: 'patch',
    path: '/{promptId}/status',
    tags: ['Prompts'],
    summary: 'Update a prompt\'s status',
    description: 'Flips a prompt to `live` or `archived`. Owner or active-org member only. Returns `data: null` on success.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
        body: {
            content: { 'application/json': { schema: StatusUpdateSchema } },
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'Status updated'),
        400: errorResponse('Invalid status'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(updateStatusRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = StatusUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(errorEnvelope(c, 'Invalid status'), 400);
    }

    const promptRecord = await promptService.getPromptRecord(promptId);
    if (!promptRecord) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    const isOwner = promptRecord.authorId === uid;
    const isOrgMember =
        !isOwner && (await organizationService.isMember(promptRecord.authorId, uid));
    if (!isOwner && !isOrgMember) {
        return c.json(errorEnvelope(c, 'Forbidden'), 403);
    }

    await promptService.updatePromptStatus(promptId, validation.data.status);

    // Status echo dropped — callers don't read it; they already know
    // what they sent. `data: null` keeps the response on the standard
    // envelope so callers can use `*Data` helpers.
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:promptId/atproto-uri
// ---------------------------------------------------------------------------

const updateAtprotoUriRoute = createRoute({
    method: 'patch',
    path: '/{promptId}/atproto-uri',
    tags: ['Prompts'],
    summary: 'Set the AT Protocol URI of a published prompt',
    description: 'Records the `at://` URI returned by the publisher after a successful `repo.putRecord` on the author\'s PDS. Owner or active-org member only. Narrow-scope endpoint — only `atprotoUri` can be set this way. Returns `data: null` on success.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
        body: {
            content: { 'application/json': { schema: AtprotoUriUpdateSchema } },
        },
    },
    responses: {
        200: jsonResponse(z.null(), 'AT Protocol URI recorded'),
        400: errorResponse('Invalid atprotoUri'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(updateAtprotoUriRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = AtprotoUriUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Invalid atprotoUri', { issues: validation.error.issues }),
            400,
        );
    }

    const promptRecord = await promptService.getPromptRecord(promptId);
    if (!promptRecord) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    const isOwner = promptRecord.authorId === uid;
    const isOrgMember =
        !isOwner && (await organizationService.isMember(promptRecord.authorId, uid));
    if (!isOwner && !isOrgMember) {
        return c.json(errorEnvelope(c, 'Forbidden'), 403);
    }

    await promptService.setPromptAtprotoUri(promptId, validation.data.atprotoUri);

    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// DELETE /:promptId
// ---------------------------------------------------------------------------

const deleteRoute = createRoute({
    method: 'delete',
    path: '/{promptId}',
    tags: ['Prompts'],
    summary: 'Delete a prompt',
    description: 'Soft-deletes the prompt (status → `deleted`). Owner or active-org member only.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.hourly)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
    },
    responses: {
        200: jsonResponse(z.null(), 'Prompt deleted'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not authorized'),
        404: errorResponse('Prompt not found'),
    },
});

app.openapi(deleteRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

    const promptRecord = await promptService.getPromptRecord(promptId);
    if (!promptRecord) {
        return c.json(errorEnvelope(c, 'Prompt not found'), 404);
    }

    const isOwner = promptRecord.authorId === uid;
    const isOrgMember =
        !isOwner && (await organizationService.isMember(promptRecord.authorId, uid));
    if (!isOwner && !isOrgMember) {
        return c.json(errorEnvelope(c, 'Forbidden'), 403);
    }

    await promptService.deletePrompt(promptId);

    // Drop the human-readable message — it was never read by callers
    // (toast text is constructed client-side). `data: null` for the
    // standard envelope.
    return c.json({ success: true as const, data: null }, 200);
});

// ---------------------------------------------------------------------------
// POST /:promptId/read — mark all replies for this prompt as read-by-viewer
// ---------------------------------------------------------------------------

const markReadRoute = createRoute({
    method: 'post',
    path: '/{promptId}/read',
    tags: ['Prompts'],
    summary: 'Mark every reply on a prompt as read by the viewer',
    description: 'Adds the viewer\'s uid to every reply\'s `readBy` set for the given prompt. Idempotent. No ownership check (matches `POST /replies/:id/read`).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
    },
    responses: {
        200: jsonResponse(z.null(), 'Replies marked read'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(markReadRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

    // Parity with apps/web: no ownership check here. `readBy` isn't projected
    // to clients (hydrateReply hardcodes it to []) and the operation is
    // idempotent arrayUnion — same reasoning as POST /replies/:id/read.
    //
    // Pull records through the query (includes status/visibility filters) so
    // deleted replies aren't counted; caller intent is "mark everything the
    // user can see on this prompt as read".
    const replies = await firebaseReplyDependencies.queryByPromptId(promptId, {
        includeArchived: true,
    });
    if (replies.length === 0) {
        return c.json({ success: true as const, data: null }, 200);
    }
    await firebaseReplyDependencies.bulkMarkRepliesRead(
        replies.map((r) => r.id),
        uid,
    );

    return c.json({ success: true as const, data: null }, 200);
});

export { app as promptsRoute };
