import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { PromptViewSchema } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { userService, promptService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

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

const ListResponseSchema = z.object({
    items: z.array(PromptViewSchema),
    nextCursor: z.string().nullable(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const listPromptsRoute = createRoute({
    method: 'get',
    path: '/{handle}/prompts',
    tags: ['Users'],
    summary: 'List a user\'s prompts',
    description: 'Paginated list of prompts authored by the user identified by handle (or raw UID). The owner sees live + archived; everyone else sees live only.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The user handle (case-insensitive) or raw UID' }),
        }),
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 20)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last prompt id from the prior page' }),
        }),
    },
    responses: {
        200: jsonResponse(ListResponseSchema, 'Paginated list of prompts'),
        400: errorResponse('Invalid query parameters'),
        404: errorResponse('User not found'),
    },
});

app.openapi(listPromptsRoute, async (c) => {
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
        success: true as const,
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
    }, 200);
});

export { app as usersPromptsRoute };
