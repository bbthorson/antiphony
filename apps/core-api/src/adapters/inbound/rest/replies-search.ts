import { Hono } from 'hono';
import { z } from 'zod';
import { toReplyViewPublic } from 'shared/types';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { replyService } from '../../outbound/firebase/core-services-firebase.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';

/**
 * GET /api/v1/replies/search?q=...&promptId=&status=&readStatus=&dateFrom=&dateTo=
 *
 * Full-text search across the authenticated viewer's replies. Returns
 *   { replies: ReplyViewPublic[], query: string }
 *
 * Filter params (validated via Zod):
 *   - `q` (required, min 2 chars) — case-insensitive transcription substring
 *   - `promptId` (optional) — scope to a single prompt
 *   - `status` — 'live' (default) | 'archived' | 'all'
 *   - `readStatus` — 'all' (default) | 'read' | 'unread'
 *   - `dateFrom` / `dateTo` — ISO datetime; inclusive
 *
 * Parity with: apps/web/src/app/api/v1/replies/search/route.ts
 */

/**
 * Zod schema. Enum fields are validated strictly (no silent coercion from
 * arbitrary strings). Date fields accept any string parseable by `Date`; we
 * reject the input if `Date.parse` returns NaN so the service layer never
 * sees an Invalid Date.
 */
const QuerySchema = z.object({
    q: z.string().min(2, 'Search query must be at least 2 characters'),
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

app.get('/search', requireAuth(), rateLimit(RATE_LIMITS.read), async (c) => {
    const uid = c.get('viewerUid')!;

    const parsed = QuerySchema.safeParse({
        q: c.req.query('q'),
        promptId: c.req.query('promptId'),
        status: c.req.query('status'),
        readStatus: c.req.query('readStatus'),
        dateFrom: c.req.query('dateFrom'),
        dateTo: c.req.query('dateTo'),
    });
    if (!parsed.success) {
        return c.json(
            errorEnvelope(c, parsed.error.issues[0]?.message || 'Invalid query'),
            400,
        );
    }

    const { q, promptId, status, readStatus, dateFrom, dateTo } = parsed.data;
    const filters: Parameters<typeof replyService.searchReplies>[2] = {
        promptId,
        status,
        readStatus,
        ...(dateFrom ? { dateFrom: new Date(dateFrom) } : {}),
        ...(dateTo ? { dateTo: new Date(dateTo) } : {}),
    };

    const results = await replyService.searchReplies(uid, q, filters);

    // Paginated/search standard shape: `data.items` is the matched replies;
    // `data.query` echoes the search input (kept for debug/UI display).
    return c.json({
        success: true,
        data: { items: results.map(toReplyViewPublic), query: q },
    });
});

export { app as repliesSearchRoute };
