import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { EraseAuthorRequestSchema } from 'shared/api-codecs';
import { EraseAuthorResultSchema } from 'shared/types/deletion';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Operations on everything one author wrote, mounted at `/api/v1/authors`.
 *
 *   POST /{authorId}/erase  — account erasure (specs/deletion.md § 4.2)
 *
 * `authorId` is the app's opaque id for a person, the `authorId` facet on their
 * posts. Antiphony holds no user data, so "the author" exists here only as that
 * facet; erasing them means deleting every post that carries it.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

/**
 * One bucket per tenant. An erasure is an operator job, not a person, so the
 * acting actor (if any) is the wrong subject; 20 pages a minute lets a large
 * account finish in minutes without letting a loop run away.
 */
const tenantKey = (c: Parameters<MiddlewareHandler>[0]): string | null => c.get('originAppId') ?? null;

const eraseRoute = createRoute({
    method: 'post',
    path: '/{authorId}/erase',
    tags: ['Posts'],
    summary: "Erase an author's posts",
    description:
        'Account erasure. Deletes every post whose `authorId` is `authorId`, prompts and replies, exactly as ' +
        '`DELETE /api/v1/posts/{postId}` would, applying `replies` to other people\'s replies below them. The ' +
        'author\'s own posts are always deleted, whatever `replies` says.\n\n' +
        'Paged: each call deletes up to `limit` posts. Repeat it until `complete` is true; a call after that is a ' +
        'no-op returning `complete: true`, so a retrying job is safe. No acting actor is required.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: tenantKey }),
        bodyLimit({
            maxSize: 4 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: {
        params: z.object({
            authorId: z.string().min(1).openapi({ description: "The app's opaque id for the author" }),
        }),
        body: { content: { 'application/json': { schema: EraseAuthorRequestSchema } }, required: false },
    },
    responses: {
        200: jsonResponse(EraseAuthorResultSchema, 'What this call deleted and kept'),
        400: errorResponse('Invalid body'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(eraseRoute, async (c) => {
    const { authorId } = c.req.valid('param');

    // The body is optional, so it is parsed here rather than by the route
    // validator, which skips a request with no JSON body and would hand back
    // nothing to apply the defaults to.
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
        try {
            raw = JSON.parse(text);
        } catch {
            return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
        }
    }
    const parsed = EraseAuthorRequestSchema.safeParse(raw);
    if (!parsed.success) {
        return c.json(errorEnvelope(c, 'Validation failed', { issues: parsed.error.issues }), 400);
    }
    const { replies, limit } = parsed.data;
    const result = await servicesFor(c.env).postDeletionService.eraseAuthor(
        getOriginAppId(c),
        authorId,
        replies,
        limit,
    );
    return c.json({ success: true as const, data: result }, 200);
});

export { app as authorsRoute };
