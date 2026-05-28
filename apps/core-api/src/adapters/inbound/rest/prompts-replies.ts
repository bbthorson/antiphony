import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toReplyViewPublic, ReplyViewSchema, ReplyViewPublicSchema } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { promptService, replyService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/prompts/:promptId/replies
 *
 * Returns the replies for a prompt with owner-aware projection:
 *   - Prompt author (`viewer.uid === prompt.authorId`) → full `ReplyView[]`
 *     with CRM fields (top-level `notes` lifted from the enrichments
 *     namespace, plus `listenerPhoneNumber`).
 *   - Everyone else → `ReplyViewPublic[]` (same shape stripped of those
 *     private fields via `toReplyViewPublic`).
 *
 * Auth is optional. Non-live prompts (archived/deleted/draft) return an
 * empty array for non-authors to match apps/web's in-process behavior; the
 * author always sees their own replies regardless of status.
 *
 * Prompt-not-found collapses to `[]` rather than 404 — matches apps/web's
 * route, whose `replyService.getRepliesForPrompt` silently returns `[]`
 * when the caller passes a bogus prompt. Keeps transport symmetric.
 *
 * Parity with: apps/web/src/app/api/v1/prompts/[promptId]/replies/route.ts
 */

const QuerySchema = z.object({
    includeArchived: z
        .preprocess((v) => v === 'true', z.boolean())
        .default(false),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const listRepliesRoute = createRoute({
    method: 'get',
    path: '/{promptId}/replies',
    tags: ['Prompts'],
    summary: 'List replies on a prompt',
    description: 'Returns every reply on the given prompt with owner-aware projection. The prompt author sees the full `ReplyView[]` (with CRM/PII state); everyone else sees `ReplyViewPublic[]`. Non-live prompts return `[]` for non-authors.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            promptId: z.string().openapi({ description: 'The prompt id' }),
        }),
        query: z.object({
            includeArchived: z.enum(['true', 'false']).optional().openapi({ description: 'When `true`, include replies whose status is `archived`. Default `false`.' }),
        }),
    },
    responses: {
        200: jsonResponse(z.union([z.array(ReplyViewSchema), z.array(ReplyViewPublicSchema)]), 'Replies on the prompt (owner-aware projection)'),
        400: errorResponse('Invalid query parameters'),
    },
});

app.openapi(listRepliesRoute, async (c) => {
    const promptId = c.req.param('promptId');

    const queryResult = QuerySchema.safeParse({
        includeArchived: c.req.query('includeArchived') ?? undefined,
    });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { includeArchived } = queryResult.data;

    const viewerUid = c.get('viewerUid');

    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json({ success: true as const, data: [] }, 200);
    }

    const isAuthor = viewerUid !== null && viewerUid === prompt.record.authorId;

    // Non-live prompts are owner-only. Non-authors get an empty list so the
    // endpoint doesn't reveal reply existence on archived / deleted / draft
    // prompts.
    if (!isAuthor && prompt.record.status !== 'live') {
        return c.json({ success: true as const, data: [] }, 200);
    }

    const replies = await replyService.getRepliesForPrompt(
        viewerUid ?? '',
        {
            id: prompt.record.id,
            authorId: prompt.record.authorId,
            status: prompt.record.status,
        },
        prompt.author,
        { includeArchived },
    );

    return c.json({
        success: true as const,
        data: isAuthor ? replies : replies.map(toReplyViewPublic),
    }, 200);
});

export { app as promptsRepliesRoute };
