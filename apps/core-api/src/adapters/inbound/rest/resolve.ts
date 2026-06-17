import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HandleResolutionSchema } from 'shared/types/views';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { feedService } from '../../outbound/firebase/core-services-firebase.js';
import { jsonResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * GET /api/v1/resolve/:handle
 *
 * Resolves a handle string to either a user profile or an organization.
 * The handle space is unified — `@voxpop` could be a user or an org slug —
 * so the endpoint tries users first, then falls back to orgs. Returns
 * `null` (in the envelope's `data`) if neither resolves.
 *
 * Public identity projection — anonymous, public-safe read. The user case
 * projects to the *basic* profile shape (no PII; see `HandleResolutionSchema`),
 * so it qualifies as a public-projection in the core contract (Plan A, A2).
 *
 * Public — no auth required. Rate-limited per `RATE_LIMITS.read`.
 *
 * Parity with: apps/web/src/app/api/v1/resolve/[handle]/route.ts
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const resolveHandleRoute = createRoute({
    method: 'get',
    path: '/{handle}',
    tags: ['Users'],
    summary: 'Resolve a handle to a user or organization',
    description:
        'Public identity lookup over the unified handle space. Returns a discriminated union — `{ type: \'user\', profile }` or `{ type: \'org\', org }` — or `null` when the handle resolves to neither. The user projection omits PII (basic profile only).',
    middleware: [rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            handle: z.string().openapi({ description: 'The handle to resolve (user handle or org slug; case-insensitive)' }),
        }),
    },
    responses: {
        200: jsonResponse(HandleResolutionSchema.nullable(), 'The resolved user or organization, or null'),
    },
});

app.openapi(resolveHandleRoute, async (c) => {
    const { handle } = c.req.valid('param');
    const resolution = await feedService.resolveHandle(handle);
    return c.json({ success: true as const, data: resolution }, 200);
});

export { app as resolveRoute };
