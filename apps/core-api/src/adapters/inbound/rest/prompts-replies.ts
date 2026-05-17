import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { promptService, replyService } from '../../outbound/firebase/core-services-firebase.js';

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

const app = new Hono();

app.get('/:promptId/replies', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const promptId = c.req.param('promptId');

    const queryResult = QuerySchema.safeParse({
        includeArchived: c.req.query('includeArchived') ?? undefined,
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
    const { includeArchived } = queryResult.data;

    const viewerUid = c.get('viewerUid');

    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json({ success: true, data: [] });
    }

    const isAuthor = viewerUid !== null && viewerUid === prompt.record.authorId;

    // Non-live prompts are owner-only. Non-authors get an empty list so the
    // endpoint doesn't reveal reply existence on archived / deleted / draft
    // prompts.
    if (!isAuthor && prompt.record.status !== 'live') {
        return c.json({ success: true, data: [] });
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
        success: true,
        data: isAuthor ? replies : replies.map(toReplyViewPublic),
    });
});

export { app as promptsRepliesRoute };
