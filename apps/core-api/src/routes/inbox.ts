import { Hono } from 'hono';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import {
    userService,
    promptService,
    replyService,
} from '../services/core-services-firebase.js';

/**
 * GET /api/v1/inbox
 *
 * Returns every reply to the authenticated user's prompts, sorted by
 * date descending (flat list, not grouped). Server-composed: fetches
 * the viewer's prompts, batch-queries replies, returns hydrated views.
 *
 * Auth: requireAuth (the response is owner-specific). Replies are
 * projected through `toReplyViewPublic` — the inbox view surface doesn't
 * include CRM-only fields; those live in the per-prompt replies endpoint.
 *
 * Parity with: apps/web/src/app/api/v1/inbox/route.ts
 */

const app = new Hono();

app.get('/', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const user = await userService.getUserDataByUid(uid);
    if (!user) {
        return c.json(
            {
                status: 'error',
                message: 'Profile not found',
                requestId: c.get('requestId'),
            },
            404,
        );
    }

    const prompts = await promptService.getPromptsForUser(uid, 100, undefined, false);
    const promptIds = prompts.map((p) => p.record.id);
    if (promptIds.length === 0) {
        return c.json({ replies: [] });
    }

    const includeArchived = c.req.query('includeArchived') === 'true';
    const repliesMap = await replyService.getRepliesForPrompts(promptIds, user, {
        includeArchived,
    });

    // Compare-by-string works for ISO-8601 date strings AND Date.toJSON()
    // output (both are ISO-8601), so we can skip the per-comparison `new
    // Date()` allocation. Date instances coerce via .toISOString()
    // implicitly when wrapped with String(), which keeps the comparison
    // lexicographic. Desc order: b first.
    const toComparable = (v: unknown): string =>
        v instanceof Date ? v.toISOString() : String(v);
    const allReplies = Array.from(repliesMap.values())
        .flat()
        .sort((a, b) => toComparable(b.record.createdAt).localeCompare(toComparable(a.record.createdAt)));

    return c.json({ replies: allReplies.map(toReplyViewPublic) });
});

export { app as inboxRoute };
