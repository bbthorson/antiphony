import { Hono } from 'hono';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { userService, promptService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/prompts/public/:handle/:promptId
 *
 * Legacy mobile endpoint — returns `{ user: ProfileView, prompt: PromptView }`
 * for the mobile app's public prompt screen. Public; no auth.
 *
 * The `handle` segment is normalized: trim leading `@`, lowercase,
 * URL-decode. The prompt is only returned if it belongs to the
 * resolved user AND is currently live — otherwise 404 (hides both
 * ownership and existence).
 *
 * Parity with: apps/web/src/app/api/v1/prompts/public/[handle]/[promptId]/route.ts
 *
 * ## Error shape
 * `{status: 'error', message}` route-return shape (matches apps/web).
 * This endpoint is a long-lived mobile contract; see
 * `specs/decoupling-migration.md` End State for the mobile cutover plan.
 */

const app = new Hono();

app.get('/:handle/:promptId', rateLimit(RATE_LIMITS.read), async (c) => {
    // `c.req.param()` already URL-decodes the path segment (unlike Next.js's
    // raw `params` object). Double-decoding would throw on literal `%`
    // characters and corrupt anything that happens to look like an encoded
    // sequence. Trust Hono's decode.
    const rawHandle = c.req.param('handle');
    const promptId = c.req.param('promptId');

    const handle = rawHandle ? rawHandle.toLowerCase().replace(/^@/, '') : '';

    if (!handle || !promptId) {
        return c.json({ status: 'error', message: 'Missing handle or promptId' }, 400);
    }

    // Parallel reads — user + prompt are independent.
    const [user, prompt] = await Promise.all([
        userService.getUserData(handle),
        promptService.getPromptData(promptId),
    ]);

    if (!user || !prompt) {
        return c.json({ status: 'error', message: 'Prompt not found' }, 404);
    }

    // Verify prompt belongs to this user AND is live. Mismatch = 404
    // (not 403) so the endpoint doesn't confirm that promptId exists.
    if (prompt.record.authorId !== user.id || prompt.record.status !== 'live') {
        return c.json({ status: 'error', message: 'Prompt not found' }, 404);
    }

    return c.json({
        success: true,
        data: { user, prompt },
    });
});

export { app as promptsPublicRoute };
