import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../middleware/rate-limit.js';
import { userService, promptService } from '../services/core-services-firebase.js';

/**
 * GET /api/v1/users/:handle/prompts
 *
 * Lists a user's prompts, hydrated as `PromptView[]`. The `handle`
 * segment accepts either a handle (source of truth in the `handles`
 * collection) or a raw UID — `userService.getUserData` has a UID
 * fallback, so either resolves to the same user.
 *
 * Visibility filter:
 *   - Owner viewer → live + archived prompts.
 *   - Anyone else (including anonymous) → live only.
 *
 * Response shape:
 *   `{ success: true, data: PromptView[], nextCursor: string | null }`
 *   or `{ success: false, error: 'User not found' }` with status 404.
 *
 * Parity with: apps/web/src/app/api/v1/users/[handle]/prompts/route.ts
 *
 * **Auth status**: pre-bearer-bridge, `viewerUid = null`, so `isOwner`
 * is always false and `publicOnly` is always true. Matches apps/web's
 * un-authenticated behavior. Flip when auth bridge lands.
 */

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
});

const app = new Hono();

app.get('/:handle/prompts', rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');

    const queryResult = QuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
    });
    if (!queryResult.success) {
        return c.json(
            { success: false, error: 'Invalid query parameters', issues: queryResult.error.issues },
            400,
        );
    }
    const { limit, cursor } = queryResult.data;

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json({ success: false, error: 'User not found' }, 404);
    }

    // TODO(auth-bridge): read viewer from Authorization header.
    const requesterId: string | null = null;
    const isOwner = requesterId !== null && requesterId === targetUser.id;

    const prompts = await promptService.getPromptsForUser(
        targetUser.id,
        limit,
        cursor,
        !isOwner,
    );

    return c.json({
        success: true,
        data: prompts,
        // Only compute a cursor when the page is full AND there's at least
        // one prompt — guards against `prompts[-1]` on empty results.
        nextCursor:
            prompts.length > 0 && prompts.length === limit
                ? prompts[prompts.length - 1].record.id
                : null,
    });
});

export { app as usersPromptsRoute };
