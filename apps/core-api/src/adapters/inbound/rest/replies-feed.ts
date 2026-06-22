import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toReplyViewPublic, ReplyViewPublicSchema } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { replyService } from '../../outbound/firebase/core-services-firebase.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/replies/feed?limit=&cursor=&promptId=&status=&readStatus=&order=&dateFrom=&dateTo=
 *
 * Cross-prompt reply feed — paginated list of the authenticated viewer's
 * replies, ordered by `order` (default `newest`/reverse-chronological).
 * Returns:
 *   { items: ReplyViewPublic[], nextCursor: string | null }
 *
 * Filters mirror `/api/v1/replies/search` minus the text query, plus cursor
 * pagination. Sibling of the search route; both delegate to `ReplyService`.
 */

/**
 * Single source of truth for query validation. Used by both the OpenAPI
 * route declaration (drives the generated spec + runtime validation) and
 * the handler (via `c.req.valid('query')`). No second `safeParse` in the
 * handler — the validator already ran.
 *
 * `.transform()` clamps `limit` to 1–100 with a default of 20; the
 * generated spec shows `limit: number` (transforms aren't rendered),
 * but the `description` documents the clamp.
 */
const QuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .refine((v) => v === undefined || /^\d+$/.test(v), { message: 'Invalid limit' })
        .transform((v) => (v === undefined ? 20 : Math.max(1, Math.min(100, parseInt(v, 10)))))
        .openapi({ description: 'Page size — clamped to 1–100; default 20.' }),
    cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last reply id from the prior page' }),
    promptId: z.string().optional().openapi({ description: 'Scope the feed to a single prompt' }),
    authorUid: z.string().optional().openapi({ description: 'Scope the feed to replies authored by this uid (the viewer\'s view of one person\'s activity)' }),
    status: z.enum(['live', 'archived', 'all']).default('live').openapi({ description: 'Reply status filter (default `live`)' }),
    readStatus: z.enum(['all', 'read', 'unread']).default('all').openapi({ description: 'Read-state filter (default `all`)' }),
    order: z.enum(['newest', 'oldest']).default('newest').openapi({ description: 'Sort direction by createdAt — `newest` (reverse-chronological, default) or `oldest`' }),
    dateFrom: z
        .string()
        .optional()
        .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), { message: 'Invalid dateFrom' })
        .openapi({ description: 'ISO datetime — inclusive lower bound' }),
    dateTo: z
        .string()
        .optional()
        .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), { message: 'Invalid dateTo' })
        .openapi({ description: 'ISO datetime — inclusive upper bound' }),
});

const FeedResponseSchema = z.object({
    items: z.array(ReplyViewPublicSchema),
    nextCursor: z.string().nullable(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const feedRoute = createRoute({
    method: 'get',
    path: '/feed',
    tags: ['Replies'],
    summary: 'List the viewer\'s replies (paginated, sortable, filterable)',
    description: 'Cross-prompt feed of the authenticated viewer\'s replies. Cursor-paginated, sortable newest/oldest by createdAt (default newest). Filter by prompt id, status, read state, and date range.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { query: QuerySchema },
    responses: {
        200: jsonResponse(FeedResponseSchema, 'Paginated reply feed'),
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(feedRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { limit, cursor, promptId, authorUid, status, readStatus, order, dateFrom, dateTo } = c.req.valid('query');

    const { replies, nextCursor } = await replyService.listReplyFeed(
        uid,
        {
            promptId,
            authorUid,
            status,
            readStatus,
            ...(dateFrom ? { dateFrom: new Date(dateFrom) } : {}),
            ...(dateTo ? { dateTo: new Date(dateTo) } : {}),
        },
        { limit, cursor, order },
    );

    // Paginated standard shape: `data.items` is the array of replies,
    // `data.nextCursor` is the pagination handle.
    return c.json({
        success: true as const,
        data: { items: replies.map(toReplyViewPublic), nextCursor },
    }, 200);
});

export { app as repliesFeedRoute };
