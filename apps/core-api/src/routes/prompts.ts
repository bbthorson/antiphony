import { Hono } from 'hono';
import { toPromptViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { promptService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/prompts/:promptId
 *
 * Returns a prompt by id with an owner-aware projection:
 *   - Owner → full `PromptView` (analytics, moderation, AI enrichment).
 *   - Non-owner → stripped `PromptViewPublic` via `toPromptViewPublic`.
 *
 * Non-live / private prompts return 404 for non-owners (existence is
 * itself hidden, not just contents). Returns 404 on unknown prompts.
 *
 * Response shape: `{ success: true, data: PromptView | PromptViewPublic }`
 * or `{ success: false, error: 'Prompt not found' }` with status 404.
 *
 * Parity with: apps/web/src/app/api/v1/prompts/[promptId]/route.ts
 *
 * **Auth**: `optionalAuth` middleware attaches `viewerUid` from a bearer
 * token if one is present. Anonymous requests get the public projection;
 * authenticated requests from the prompt owner get the full view.
 */

const app = new Hono();

app.get('/:promptId', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const promptId = c.req.param('promptId');
    const prompt = await promptService.getPromptData(promptId);
    if (!prompt) {
        return c.json({ success: false, error: 'Prompt not found' }, 404);
    }

    const viewerUid = c.get('viewerUid');
    const isOwner = viewerUid !== null && viewerUid === prompt.record.authorId;

    // Hide existence of non-live/private prompts from non-owners.
    if (!isOwner && (prompt.record.status !== 'live' || prompt.visibility === 'private')) {
        return c.json({ success: false, error: 'Prompt not found' }, 404);
    }

    return c.json({
        success: true,
        data: isOwner ? prompt : toPromptViewPublic(prompt),
    });
});

export { app as promptsRoute };
