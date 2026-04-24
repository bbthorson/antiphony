import { Hono } from 'hono';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { requireAuth } from '../middleware/auth.js';
import { feedService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/people/:handle/replies
 *
 * Returns all replies from a specific person (identified by handle) across
 * the authenticated viewer's prompts — the CRM "person detail" feed. Shape:
 *
 *   { replies: ReplyViewPublic[], promptTitles: Record<promptId, title> }
 *
 * `toReplyViewPublic` strips CRM-only fields (authorRating, authorTags,
 * authorNotes, record.notes, listenerPhoneNumber). The caller is already
 * the prompt owner, but the existing apps/web parity route returns
 * ReplyViewPublic (not full ReplyView) here — preserved for client-shape
 * parity.
 *
 * Parity with: apps/web/src/app/api/v1/people/[handle]/replies/route.ts
 */

const app = new Hono();

app.get('/:handle/replies', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;
    const handle = c.req.param('handle');

    const result = await feedService.getPersonReplies(uid, handle);

    return c.json({
        replies: result.replies.map(toReplyViewPublic),
        promptTitles: result.promptTitles,
    });
});

export { app as peopleRepliesRoute };
