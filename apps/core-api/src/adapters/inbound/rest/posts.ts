import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { AudioPostViewSchema } from 'shared/types/audio';
import { CreateAudioPostRequestSchema, PatchAudioPostRequestSchema } from 'shared/api-codecs';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth, requireServiceToken } from '../../../middleware/auth.js';
import { audioPostService } from '../../outbound/firebase/core-services-firebase.js';
import {
    checkIdempotency,
    saveIdempotencyResult,
    IdempotencyInProgressError,
} from '../../../lib/idempotency.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { resolveInitialProcessing, hasPendingStage, dispatchProcessing } from '../../../lib/audio-processing.js';
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
 *   PATCH  /:postId           — (re)trigger audio enrichment (processing only)
 *
 * This is the canonical content surface: a single post collection where
 * `reply` presence discriminates a prompt (thread root) from a reply. The
 * legacy `/prompts` + `/replies` + `/organizations` surface has been removed.
 *
 * **Tenancy:** every read/write is scoped to a single `originAppId` — derived
 * from the caller's service credential when present, else deploy config
 * (`ANTIPHONY_ORIGIN_APP_ID`, default `antiphony`). See `lib/origin-app.ts`
 * and `specs/service-auth.md`. Always stamped server-side.
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
    // Facet filter: replies whose thread ROOT was authored by this id — i.e.
    // "replies addressed to author X". A different slice of the same posts
    // collection than the viewer's own posts (the default). Mutually exclusive
    // with the viewer-authored view: when set, the list is NOT scoped to the
    // viewer as author, and `kind` is implied `reply` (so it's ignored).
    rootAuthor: z.string().min(1).optional(),
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
    summary: "List audio posts (the viewer's own, or replies addressed to an author)",
    description:
        "Paginated list of audio posts within this deploy's origin app. By default, the posts authored " +
        'by the viewer (optionally filtered by `kind`). With `rootAuthor` set, instead returns the replies ' +
        'whose thread root was authored by that id — "replies addressed to author X", the raw feed a ' +
        'connector composes into an inbox. Cursor-paginated by post id.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.read)] as const,
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 20)' }),
            cursor: z.string().optional().openapi({ description: 'Pagination cursor — the last post id from the prior page' }),
            kind: z.enum(['prompt', 'reply']).optional().openapi({ description: 'Restrict to prompts or replies (ignored when `rootAuthor` is set)' }),
            rootAuthor: z.string().optional().openapi({ description: 'Return replies addressed to this author (thread-root author) instead of the viewer\'s own posts' }),
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
        rootAuthor: c.req.query('rootAuthor'),
    });
    if (!queryResult.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: queryResult.error.issues }),
            400,
        );
    }
    const { limit, cursor, kind, rootAuthor } = queryResult.data;
    const originAppId = getOriginAppId(c);

    // `rootAuthor` selects a different slice of the collection: replies addressed
    // to that author (the `rootAuthorId` facet), NOT the viewer's own posts. The
    // default view stays viewer-authored (`authorId == uid`).
    const items = rootAuthor
        ? await audioPostService.getRepliesByRootAuthor(originAppId, rootAuthor, uid, {
              limit,
              cursorId: cursor,
          })
        : await audioPostService.getPostsForAuthor(originAppId, uid, uid, {
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
        'Scoped to the origin app — a post from another origin app reads as 404. ' +
        'Requires a service token (establishes the tenant); omit `X-Antiphony-Acting-Actor` for an anonymous (viewer-less) read.',
    middleware: [requireServiceToken(), rateLimit(RATE_LIMITS.read)] as const,
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

    const view = await audioPostService.getPostView(getOriginAppId(c), postId, viewerUid);
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
        '(oldest first). Cursor-paginated. Scoped to the origin app. Requires a service token; omit ' +
        '`X-Antiphony-Acting-Actor` for an anonymous (viewer-less) read.',
    middleware: [requireServiceToken(), rateLimit(RATE_LIMITS.read)] as const,
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
    const originAppId = getOriginAppId(c);

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

    const { text, title, embed, reply, langs, selfLabels, processing } = validation.data;

    const originAppId = getOriginAppId(c);
    // Resolve the opt-in request against this deployment's capabilities: each
    // requested stage starts `pending` (worker will do it) or `skipped` (no
    // provider configured). Stored on the record; surfaced on the view.
    const initialProcessing = resolveInitialProcessing(processing);

    const created = await audioPostService.createPost({
        originAppId,
        authorId: uid,
        // App-asserted AT Protocol DID (service path only) — trusted within
        // the app's tenancy; see specs/service-auth.md.
        authorDid: c.get('actingActorDid') ?? undefined,
        text,
        title,
        embed,
        reply,
        langs,
        selfLabels,
        processing: initialProcessing,
    });

    // Kick off processing for any stage that's actually pending. In inline
    // mode this awaits; the durable Cloud Tasks trigger lands in a later PR.
    if (hasPendingStage(initialProcessing)) {
        await dispatchProcessing(originAppId, created.id);
    }

    const responseBody = { success: true as const, data: { postId: created.id } };
    await saveIdempotencyResult(c, uid, responseBody);

    return c.json(responseBody, 200);
});

// ---------------------------------------------------------------------------
// PATCH /:postId — (re)trigger audio enrichment (processing opt-in ONLY)
// ---------------------------------------------------------------------------

const patchRoute = createRoute({
    method: 'patch',
    path: '/{postId}',
    tags: ['Posts'],
    summary: 'Trigger audio enrichment on a post',
    description:
        '(Re)runs async audio processing (transcribe / denoise) on an existing post. The body accepts ' +
        '**only** a `processing` opt-in — no lexicon fields are editable, because those feed the record ' +
        'CID (its content identity); processing state is storage-layer, so this changes no CID. ' +
        'Author-only: the acting viewer must be the post author. Returns the re-hydrated `AudioPostView`.',
    middleware: [requireAuth(), rateLimit(RATE_LIMITS.write)] as const,
    request: {
        params: z.object({
            postId: z.string().openapi({ description: 'The post id' }),
        }),
        body: {
            content: { 'application/json': { schema: PatchAudioPostRequestSchema } },
        },
    },
    responses: {
        200: jsonResponse(AudioPostViewSchema, 'Post updated; re-hydrated view'),
        400: errorResponse('Validation failed (no processing stage requested / no audio to process)'),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not the post author'),
        404: errorResponse('Post not found'),
    },
});

app.openapi(patchRoute, async (c) => {
    const uid = c.get('viewerUid')!;
    const postId = c.req.param('postId');
    const originAppId = getOriginAppId(c);

    let rawData: unknown;
    try {
        rawData = await c.req.json();
    } catch {
        return c.json(errorEnvelope(c, 'Invalid JSON body'), 400);
    }

    const validation = PatchAudioPostRequestSchema.safeParse(rawData);
    if (!validation.success) {
        return c.json(
            errorEnvelope(c, 'Validation failed', { issues: validation.error.issues }),
            400,
        );
    }

    // Resolve the opt-in against this deployment's capabilities (pending/skipped).
    // Undefined ⇒ the request named no stage (or only `false`s) — a no-op PATCH.
    const resolved = resolveInitialProcessing(validation.data.processing);
    if (!resolved) {
        return c.json(
            errorEnvelope(c, 'Request must enable at least one processing stage'),
            400,
        );
    }

    // Author check + persist happen in the service (throws 403/404/400 mapped by
    // the error handler). Content address is unchanged — processing is storage-layer.
    await audioPostService.setProcessing(originAppId, postId, uid, resolved);

    // Kick off any stage that's actually pending. Inline mode awaits; the
    // durable Cloud Tasks trigger lands in a later PR (same seam as create).
    if (hasPendingStage(resolved)) {
        await dispatchProcessing(originAppId, postId);
    }

    // Re-read fresh so the view reflects any inline processing results.
    const view = await audioPostService.getPostView(originAppId, postId, uid);
    if (!view) {
        return c.json(errorEnvelope(c, 'Post not found'), 404);
    }

    return c.json({ success: true as const, data: view }, 200);
});

export { app as postsRoute };
