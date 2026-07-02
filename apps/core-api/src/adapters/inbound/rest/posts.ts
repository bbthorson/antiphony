import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { AudioPostViewSchema } from 'shared/types/audio';
import { CreateAudioPostRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { audioPostService } from '../../outbound/firebase/core-services-firebase.js';
import {
    checkIdempotency,
    saveIdempotencyResult,
    IdempotencyInProgressError,
} from '../../../lib/idempotency.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Antiphony audio-post endpoints mounted at `/api/v1/posts`
 * (the `dev.antiphony.audio.post` model).
 *
 *   GET    /                  — list the viewer's posts (paginated, kind filter)
 *   GET    /:postId           — single hydrated AudioPostView (optional auth)
 *   GET    /:postId/replies   — thread: replies to the post (paginated)
 *   POST   /                  — create a post (idempotency-capable)
 *
 * This is the canonical content surface: a single post collection where
 * `reply` presence discriminates a prompt (thread root) from a reply. The
 * legacy `/prompts` + `/replies` + `/organizations` surface has been removed.
 *
 * **Tenancy:** every read/write is scoped to a single `originAppId`, resolved
 * from configuration (`ANTIPHONY_ORIGIN_APP_ID`, default `antiphony`) — see
 * `lib/origin-app.ts`. The origin app is always stamped server-side.
 */

/**
 * Recover the internal post id from a hydrated view's `at://` uri (the id is
 * the last path segment — see `buildPostUri`). Used to derive the pagination
 * cursor and the parent uri for thread queries.
 */
function postIdFromUri(uri: string): string {
    return uri.slice(uri.lastIndexOf('/') + 1);
}

const ListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    kind: z.enum(['prompt', 'reply']).optional(),
});

const ListResponseSchema = z.object({
    items: z.array(AudioPostViewSchema),
    nextCursor: z.string().nullable(),
});

const CreateResponseSchema = z.object({ postId: z.string() });

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

// ---------------------------------------------------------------------------
// GET / — list the viewer's posts (paginated)
// ---------------------------------------------------------------------------

const listRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Posts'],
    summary: "List the authenticated viewer's audio posts",
    description:
        "Paginated list of audio posts authored by the viewer within this deploy's origin app. " +
        'Optional `kind` filter (`prompt`|`reply`). Cursor-paginated by post id.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 20)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last post id from the prior page' }),
            kind: z.enum(['prompt', 'reply']).optional().openapi({ description: 'Restrict to prompts or replies' }),
        }),
    },
    responses: {
        200: jsonResponse(ListResponseSchema, "Paginated list of the viewer's posts"),
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(listRoute, async (c) => {
    const uid = c.get('viewerUid')!;

    const queryResult = ListQuerySchema.safeParse({
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
        kind: c.req.query('kind'),
    });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { limit, cursor, kind } = queryResult.data;

    const items = await audioPostService.getPostsForAuthor(getOriginAppId(), uid, uid, {
        limit,
        cursorId: cursor,
        kind,
    });

    return c.json({
        success: true as const,
        data: {
            items,
            // Only set a cursor when the page is full AND non-empty.
            nextCursor:
                items.length > 0 && items.length === limit
                    ? postIdFromUri(items[items.length - 1].uri)
                    : null,
        },
    }, 200);
});

// ---------------------------------------------------------------------------
// GET /:postId
// ---------------------------------------------------------------------------

const getByIdRoute = createRoute({
    method: 'get',
    path: '/{postId}',
    tags: ['Posts'],
    summary: 'Get an audio post by id',
    description:
        'Returns the hydrated `AudioPostView` (author + signed audio URL + lifted transcript + viewer state). ' +
        'Scoped to the origin app — a post from another origin app reads as 404.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            postId: z.string().openapi({ description: 'The post id' }),
        }),
    },
    responses: {
        200: jsonResponse(AudioPostViewSchema, 'Hydrated audio post'),
        404: errorResponse('Post not found'),
    },
});

app.openapi(getByIdRoute, async (c) => {
    const postId = c.req.param('postId');
    const viewerUid = c.get('viewerUid');

    const view = await audioPostService.getPostView(getOriginAppId(), postId, viewerUid);
    if (!view) {
        return c.json(errorEnvelope(c, 'Post not found'), 404);
    }

    return c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// GET /:postId/replies — thread
// ---------------------------------------------------------------------------

const repliesRoute = createRoute({
    method: 'get',
    path: '/{postId}/replies',
    tags: ['Posts'],
    summary: 'List replies to an audio post',
    description:
        'Returns the post\'s direct replies (posts whose `reply.parent` is this post), in thread order ' +
        '(oldest first). Cursor-paginated. Scoped to the origin app.',
    middleware: [optionalAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        params: z.object({
            postId: z.string().openapi({ description: 'The parent post id' }),
        }),
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 50)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last reply id from the prior page' }),
        }),
    },
    responses: {
        200: jsonResponse(ListResponseSchema, 'Paginated replies in thread order'),
        400: errorResponse('Invalid query parameters'),
        404: errorResponse('Parent post not found'),
    },
});

app.openapi(repliesRoute, async (c) => {
    const postId = c.req.param('postId');
    const viewerUid = c.get('viewerUid');
    const originAppId = getOriginAppId();

    const queryResult = z
        .object({
            limit: z.coerce.number().int().min(1).max(100).default(50),
            cursor: z.string().min(1).optional(),
        })
        .safeParse({ limit: c.req.query('limit'), cursor: c.req.query('cursor') });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { limit, cursor } = queryResult.data;

    // Resolve the parent so the thread query keys on the SAME `at://` uri the
    // client received on the parent view (and so a missing parent is a clean
    // 404 rather than an empty list).
    const parent = await audioPostService.getPostView(originAppId, postId, viewerUid);
    if (!parent) {
        return c.json(errorEnvelope(c, 'Post not found'), 404);
    }

    const items = await audioPostService.getReplies(originAppId, parent.uri, viewerUid, {
        limit,
        cursorId: cursor,
    });

    return c.json({
        success: true as const,
        data: {
            items,
            nextCursor:
                items.length > 0 && items.length === limit
                    ? postIdFromUri(items[items.length - 1].uri)
                    : null,
        },
    }, 200);
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------

const createRouteDef = createRoute({
    method: 'post',
    path: '/',
    tags: ['Posts'],
    summary: 'Create an audio post',
    description:
        'Creates a `dev.antiphony.audio.post` authored by the viewer. `reply` presence makes it a reply ' +
        '(no title); absence makes it a prompt. The audio is uploaded first (signed-URL flow) and referenced ' +
        'as the `embed`. `originAppId`/`authorId`/`kind` are stamped server-side. Supports `Idempotency-Key`.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        headers: z.object({
            'idempotency-key': z.string().optional().openapi({ description: 'Optional idempotency key — repeated requests with the same key return the cached response.' }),
        }),
        body: {
            content: { 'application/json': { schema: CreateAudioPostRequestSchema } },
        },
    },
    responses: {
        200: jsonResponse(CreateResponseSchema, 'Post created'),
        400: errorResponse('Validation failed'),
        401: errorResponse('Not authenticated'),
        409: errorResponse('Idempotency conflict — prior request still in flight'),
    },
});

app.openapi(createRouteDef, async (c) => {
    const uid = c.get('viewerUid')!;

    // Idempotency: a retry with the same key returns the cached response
    // (completed) or 409 (still processing). Doc id is per-user (M5 fix).
    try {
        const idem = await checkIdempotency(c, uid);
        if (idem) {
            return c.json(idem.cached as object, 200);
        }
    } catch (err) {
        if (err instanceof IdempotencyInProgressError) {
            return c.json(errorEnvelope(c, err.message), 409);
        }
        throw err;
    }

    let rawData: unknown;
    try {
        rawData = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = CreateAudioPostRequestSchema.safeParse(rawData);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Validation failed', { issues: validation.error.issues }),
            400,
        );
    }

    const { text, title, embed, reply, langs, selfLabels } = validation.data;

    const created = await audioPostService.createPost({
        originAppId: getOriginAppId(),
        authorId: uid,
        text,
        title,
        embed,
        reply,
        langs,
        selfLabels,
    });

    const responseBody = { success: true as const, data: { postId: created.id } };
    await saveIdempotencyResult(c, uid, responseBody);

    return c.json(responseBody, 200);
});

export { app as postsRoute };
