import { Hono } from 'hono';
import { z } from 'zod';
import { toPromptViewPublic } from 'shared/types';
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

/**
 * Prompt endpoints mounted at `/api/v1/prompts`.
 *
 *   GET    /                     — list authenticated viewer's prompts (paginated)
 *   GET    /:promptId            — owner-aware PromptView (optional auth)
 *   POST   /                     — create prompt (idempotency-capable)
 *   PATCH  /:promptId/status     — update status (live/archived)
 *   DELETE /:promptId            — soft-delete (status -> deleted)
 *   POST   /:promptId/read       — mark all replies for the prompt as read
 *
 * Parity sources:
 *   apps/web/src/app/api/v1/prompts/route.ts (GET list + POST create)
 *   apps/web/src/app/api/v1/prompts/[promptId]/route.ts (GET + DELETE)
 *   apps/web/src/app/api/v1/prompts/[promptId]/status/route.ts (PATCH)
 *   apps/web/src/app/api/v1/prompts/[promptId]/read/route.ts (POST)
 *
 * **Ownership model** (for writes): the prompt's `authorId` is the owner.
 * Org members can also act on the prompt if the author is an org — this
 * mirrors apps/web's `isMember(authorId, uid)` check, which treats the
 * author field as either a user id or an org id.
 */

const StatusUpdateSchema = z.object({ status: z.enum(['live', 'archived']) });

const ListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
});

const app = new Hono();

// ---------------------------------------------------------------------------
// GET / — list viewer's prompts (paginated)
// ---------------------------------------------------------------------------
//
// Mirrors apps/web's GET /api/v1/prompts: auth-required, returns
// `{ success: true, data: PromptView[], nextCursor }`. Cursor is the last
// prompt's id when the page is full, null otherwise.

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const queryResult = ListQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
    });
    if (!queryResult.success) {
        return c.json(
            {
                success: false,
                error: 'Invalid query parameters',
                issues: queryResult.error.issues,
            },
            400,
        );
    }
    const { limit, cursor } = queryResult.data;

    const prompts = await promptService.getPromptsForUser(uid, limit, cursor);

    return c.json({
        success: true,
        data: prompts,
        // Only set a cursor when the page is full AND non-empty — guards
        // against `prompts[-1]` on empty pages.
        nextCursor:
            prompts.length > 0 && prompts.length === limit
                ? prompts[prompts.length - 1].record.id
                : null,
    });
});

// ---------------------------------------------------------------------------
// GET /:promptId
// ---------------------------------------------------------------------------

app.get('/:promptId', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const promptId = c.req.param('promptId');
    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json({ success: false, error: 'Prompt not found' }, 404);
    }

    const viewerUid = c.get('viewerUid');
    const isOwner = viewerUid !== null && viewerUid === prompt.record.authorId;

    if (!isOwner && (prompt.record.status !== 'live' || prompt.visibility === 'private')) {
        return c.json({ success: false, error: 'Prompt not found' }, 404);
    }

    return c.json({
        success: true,
        data: isOwner ? prompt : toPromptViewPublic(prompt),
    });
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------

app.post('/', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const session = c.get('viewerSession');

    // `currentOrg` lives on the session as a custom claim — matches apps/web's
    // protectedRouteWithOrg shape (set at org-switch time).
    const currentOrg = (session?.currentOrg ?? null) as string | null;

    if (currentOrg) {
        const isMember = await organizationService.isMember(currentOrg, uid);
        if (!isMember) {
            return c.json(
                {
                    status: 'error',
                    message: 'Not a member of active organization',
                    requestId: c.get('requestId'),
                },
                403,
            );
        }
    }

    // Idempotency: if the client retries with the same Idempotency-Key, we
    // either return the cached response (completed) or 409 (still processing).
    try {
        const idem = await checkIdempotency(c);
        if (idem) {
            return c.json(idem.cached as object);
        }
    } catch (err) {
        if (err instanceof IdempotencyInProgressError) {
            return c.json(
                {
                    status: 'error',
                    message: err.message,
                    requestId: c.get('requestId'),
                },
                409,
            );
        }
        throw err;
    }

    // Body parsing. apps/web supports JSON + multipart; core-api accepts JSON
    // only — apps/web is already a pure HTTP client at the post-flip point, so
    // the multipart path (legacy hosted form) has no remaining callers.
    let rawData: unknown;
    try {
        rawData = await c.req.json();
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

    const validation = CreatePromptRequestSchema.safeParse(rawData);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Validation failed',
                issues: validation.error.issues,
                requestId: c.get('requestId'),
            },
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

    const responseBody = { success: true, promptId: created.id };
    await saveIdempotencyResult(c, responseBody);

    return c.json(responseBody);
});

// ---------------------------------------------------------------------------
// PATCH /:promptId/status
// ---------------------------------------------------------------------------

app.patch('/:promptId/status', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

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

    const validation = StatusUpdateSchema.safeParse(body);
    if (!validation.success) {
        return c.json(
            {
                status: 'error',
                message: 'Invalid status',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const promptRecord = await promptService.getPromptRecord(promptId);
    if (!promptRecord) {
        return c.json(
            {
                status: 'error',
                message: 'Prompt not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const isOwner = promptRecord.authorId === uid;
    const isOrgMember =
        !isOwner && (await organizationService.isMember(promptRecord.authorId, uid));
    if (!isOwner && !isOrgMember) {
        return c.json(
            {
                status: 'error',
                message: 'Forbidden',
                requestId: c.get('requestId'),
            },
            403,
        );
    }

    await promptService.updatePromptStatus(promptId, validation.data.status);

    return c.json({ success: true, status: validation.data.status });
});

// ---------------------------------------------------------------------------
// DELETE /:promptId
// ---------------------------------------------------------------------------

app.delete('/:promptId', requireAuth(), rateLimit(RATE_LIMITS.hourly), async (c) => {
    const uid = c.get('viewerUid')!;
    const promptId = c.req.param('promptId');

    const promptRecord = await promptService.getPromptRecord(promptId);
    if (!promptRecord) {
        return c.json(
            {
                status: 'error',
                message: 'Prompt not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const isOwner = promptRecord.authorId === uid;
    const isOrgMember =
        !isOwner && (await organizationService.isMember(promptRecord.authorId, uid));
    if (!isOwner && !isOrgMember) {
        return c.json(
            {
                status: 'error',
                message: 'Forbidden',
                requestId: c.get('requestId'),
            },
            403,
        );
    }

    await promptService.deletePrompt(promptId);

    return c.json({ success: true, message: 'Prompt deleted' });
});

// ---------------------------------------------------------------------------
// POST /:promptId/read — mark all replies for this prompt as read-by-viewer
// ---------------------------------------------------------------------------

app.post('/:promptId/read', requireAuth(), rateLimit(RATE_LIMITS.write), async (c) => {
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
        return c.json({ success: true });
    }
    await firebaseReplyDependencies.bulkMarkRepliesRead(
        replies.map((r) => r.id),
        uid,
    );

    return c.json({ success: true });
});

export { app as promptsRoute };
