import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { toReplyViewPublic, ReplyViewPublicSchema } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth } from '../../../middleware/auth.js';
import { replyService } from '../../outbound/firebase/core-services-firebase.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/replies/search?q=...&promptId=&status=&readStatus=&dateFrom=&dateTo=
 *
 * Full-text search across the authenticated viewer's replies. Returns
 *   { items: ReplyViewPublic[], query: string }
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
 * Single source of truth for query validation — used by both the OpenAPI
 * route (drives the spec + runtime validator) and the handler (via
 * `c.req.valid('query')`). `q` is required, so the generated client
 * types correctly express that contract.
 *
 * The min-length-2 message surfaces as the top-level error message via
 * the envelope hook's single-issue passthrough (see
 * `envelopeValidationHook`).
 */
const QuerySchema = z.object({
    q: z.string().min(2, 'Search query must be at least 2 characters').openapi({ description: 'Search term (min 2 chars)' }),
    promptId: z.string().optional().openapi({ description: 'Scope search to a single prompt' }),
    status: z.enum(['live', 'archived', 'all']).default('live').openapi({ description: 'Reply status filter (default `live`)' }),
    readStatus: z.enum(['all', 'read', 'unread']).default('all').openapi({ description: 'Read-state filter (default `all`)' }),
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

const SearchResponseSchema = z.object({
    items: z.array(ReplyViewPublicSchema),
    query: z.string(),
});

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const searchRoute = createRoute({
    method: 'get',
    path: '/search',
    tags: ['Replies'],
    summary: 'Search the viewer\'s replies by transcription',
    description: 'Case-insensitive transcription substring search across the authenticated viewer\'s replies. Filters mirror the feed endpoint plus a required `q` (min 2 chars).',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: { query: QuerySchema },
    responses: {
        200: jsonResponse(SearchResponseSchema, 'Matched replies'),
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(searchRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const { q, promptId, status, readStatus, dateFrom, dateTo } = c.req.valid('query');

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
        success: true as const,
        data: { items: results.map(toReplyViewPublic), query: q },
    }, 200);
});

export { app as repliesSearchRoute };
