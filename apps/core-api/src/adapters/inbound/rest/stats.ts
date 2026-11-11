import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TenantStatsSchema } from 'shared/types/stats';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Tenancy stats, mounted at `/api/v1/stats` (specs/tenancy-stats.md): the REST
 * twin of the XRPC query `dev.antiphony.tenant.getStats`. Lexicon-first: the
 * lexicon is the contract, and both surfaces call the same service method, so
 * they cannot count differently. This one wraps the answer in the envelope.
 *
 *   GET /  — post counts for the calling tenant
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const getRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Tenant'],
    summary: "Count the tenant's posts",
    description:
        "Post counts for the calling tenant, and only the calling tenant: the service token names it. `posts` counts " +
        'hosted posts and `remotePosts` the remote posts the tenant registered, each as `totals` and as `windows` ' +
        '(`last24h`, `last7d`), every one split into `posts`, `prompts` and `replies`. A tenant with nothing gets ' +
        'zeros, not 404. Windows are by creation time and end at `asOf`; for a remote post that is its record\'s own ' +
        '`createdAt`, not when it was registered. Every figure is counted in one read at `asOf`, so `prompts + ' +
        'replies = posts` in each; keep `asOf` to show how fresh a cached copy is.\n\n' +
        'Counts only, by design: no per-author figure, no date-range parameter, no other tenant\'s numbers, and no ' +
        'way to enumerate a post. Needs the service token and no acting actor (one sent is ignored). Rate limited as ' +
        'a read: 60 per minute per client IP, a bucket shared with the tenant\'s other reads from that address, so ' +
        'poll at a sane interval. The REST twin of the XRPC query `dev.antiphony.tenant.getStats` ' +
        '(`GET /xrpc/dev.antiphony.tenant.getStats`), which answers the same body without the envelope.',
    middleware: [requireServiceToken(), rateLimit(RATE_LIMITS.read)] as const,
    responses: {
        200: jsonResponse(TenantStatsSchema, 'The counts'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(getRoute, async (c) => {
    const data = await servicesFor(c.env).tenantStatsService.getStats(getOriginAppId(c));
    return c.json({ success: true as const, data }, 200);
});

export { app as statsRoute };
