import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { replyService } from '../../outbound/firebase/core-services-firebase.js';

/**
 * GET /api/v1/replies/feed?limit=&cursor=&promptId=&status=&readStatus=&dateFrom=&dateTo=
 *
 * Cross-prompt reply feed — paginated, reverse-chronological list of the
 * authenticated viewer's replies. Returns:
 *   { replies: ReplyViewPublic[], nextCursor: string | null }
 *
 * Filters mirror `/api/v1/replies/search` minus the text query, plus cursor
 * pagination. Sibling of the search route; both delegate to `ReplyService`.
 */

const QuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .refine((v) => v === undefined || /^\d+$/.test(v), { message: 'Invalid limit' })
        .transform((v) => (v === undefined ? 20 : Math.max(1, Math.min(100, parseInt(v, 10))))),
    cursor: z.string().optional(),
    promptId: z.string().optional(),
    status: z.enum(['live', 'archived', 'all']).default('live'),
    readStatus: z.enum(['all', 'read', 'unread']).default('all'),
    dateFrom: z
        .string()
        .optional()
        .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
            message: 'Invalid dateFrom',
        }),
    dateTo: z
        .string()
        .optional()
        .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
            message: 'Invalid dateTo',
        }),
});

const app = new Hono();

app.get('/feed', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const parsed = QuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
        promptId: c.req.query('promptId'),
        status: c.req.query('status'),
        readStatus: c.req.query('readStatus'),
        dateFrom: c.req.query('dateFrom'),
        dateTo: c.req.query('dateTo'),
    });
    if (!parsed.success) {
        return c.json(
            {
                status: 'error',
                message: parsed.error.issues[0]?.message || 'Invalid query',
                requestId: c.get('requestId'),
            },
            400,
        );
    }

    const { limit, cursor, promptId, status, readStatus, dateFrom, dateTo } = parsed.data;

    const { replies, nextCursor } = await replyService.listReplyFeed(
        uid,
        {
            promptId,
            status,
            readStatus,
            ...(dateFrom ? { dateFrom: new Date(dateFrom) } : {}),
            ...(dateTo ? { dateTo: new Date(dateTo) } : {}),
        },
        { limit, cursor },
    );

    // Paginated standard shape: `data.items` is the array of replies,
    // `data.nextCursor` is the pagination handle.
    return c.json({
        success: true,
        data: { items: replies.map(toReplyViewPublic), nextCursor },
    });
});

export { app as repliesFeedRoute };
