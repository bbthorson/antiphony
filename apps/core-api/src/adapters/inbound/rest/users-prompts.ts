import { Hono } from 'hono';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { userService, promptService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

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
 *   `{ success: true, data: { items: PromptView[], nextCursor: string | null } }`
 *   or 404 with the standard error envelope when the user isn't found.
 *
 * Parity with: apps/web/src/app/api/v1/users/[handle]/prompts/route.ts
 *
 * **Auth**: `optionalAuth` attaches the viewer's uid from a bearer token
 * if present. The owner (viewer === target user) sees live + archived;
 * everyone else (including anonymous) sees live only.
 */

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
});

const app = new Hono();

app.get('/:handle/prompts', optionalAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const handle = c.req.param('handle');

    const queryResult = QuerySchema.safeParse({
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

    const targetUser = await userService.getUserData(handle);
    if (!targetUser) {
        return c.json(errorEnvelope(c, 'User not found'), 404);
    }

    const requesterId = c.get('viewerUid');
    const isOwner = requesterId !== null && requesterId === targetUser.id;

    const prompts = await promptService.getPromptsForUser(
        targetUser.id,
        limit,
        cursor,
        !isOwner,
    );

    // Paginated standard shape: nested cursor inside `data` alongside
    // `items`. See envelope-Phase-3.
    return c.json({
        success: true,
        data: {
            items: prompts,
            // Only compute a cursor when the page is full AND there's at
            // least one prompt — guards against `prompts[-1]` on empty
            // results.
            nextCursor:
                prompts.length > 0 && prompts.length === limit
                    ? prompts[prompts.length - 1].record.id
                    : null,
        },
    });
});

export { app as usersPromptsRoute };
