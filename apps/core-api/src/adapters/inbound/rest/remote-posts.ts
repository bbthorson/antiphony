import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import {
    DeleteRemotePostResultSchema,
    PatchRemotePostRequestSchema,
    RegisterRemotePostRequestSchema,
    RemotePostUriSchema,
    RemotePostViewSchema,
    RemoteThreadViewSchema,
} from 'shared/types/remote-posts';
import { rateLimit, RATE_LIMITS, actingActorKey } from '../../../middleware/rate-limit.js';
import { requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { errorEnvelope } from '../../../lib/error-envelope.js';
import { dispatchRemoteProcessing, resolveInitialProcessing } from '../../../lib/audio-processing.js';
import { jsonResponse, errorResponse, envelopeValidationHook } from '../../../lib/openapi-envelopes.js';

/**
 * Remote posts, mounted at `/api/v1/remote-posts` (specs/audio-service-mode.md,
 * Phase A): audio whose `dev.antiphony.audio.post` record lives in a repo
 * Antiphony doesn't host, such as a player's PDS or a group's repo on its
 * group host. Phase A covers public repo records.
 *
 *   PUT    /                 — register a record by URI and CID
 *   GET    /?uri=            — one registered post
 *   GET    /thread?root=     — the registered replies under a root
 *   PATCH  /?uri=            — request processing
 *   DELETE /?uri=            — remove a registration and Antiphony's copy
 *
 * The URI goes in the query, because an `at://` URI doesn't fit in a path
 * segment. Tenant-level, like `/api/v1/dids`: a remote post has no author
 * facet here, so a service token is enough.
 */

const app = new OpenAPIHono({ defaultHook: envelopeValidationHook });

const UriQuerySchema = z.object({
    uri: RemotePostUriSchema.openapi({ description: 'The record URI, `at://{did}/dev.antiphony.audio.post/{rkey}`.' }),
});

const env = (c: { env: unknown }) => c.env as Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// PUT / — register
// ---------------------------------------------------------------------------

const putRoute = createRoute({
    method: 'put',
    path: '/',
    tags: ['Remote posts'],
    summary: 'Register a post held in another repo',
    description:
        'Registers a `dev.antiphony.audio.post` record that lives in a repo Antiphony does not host, so its audio can ' +
        "be processed and played here. Antiphony reads the record from the repo its URI names (the DID's " +
        '`#atproto_pds`), never from the request: it recomputes the record CID and requires it to equal `cid` (409 ' +
        '`REMOTE_CID_MISMATCH` if the record changed), checks it is an audio post, then copies the blob after checking ' +
        'its bytes hash to the blob ref and are audio (422 `REMOTE_RECORD_INVALID` otherwise). A record the repo says ' +
        'does not exist is 404 `REMOTE_RECORD_NOT_FOUND`; a repo that cannot be read right now is 503 ' +
        '`REMOTE_REPO_UNREACHABLE`. Phase A takes public repo records only: a space record URI is 400 ' +
        '`REMOTE_URI_UNSUPPORTED`. Repeating a registration is a no-op (200); a new `cid` for the same URI takes the ' +
        "edit (200). If the tenant already uploaded the same bytes, they aren't downloaded again; bytes stored as " +
        'private audio in a space are refused (409 `REMOTE_BLOB_PRIVATE`). `processing` opts into stages as on ' +
        '`POST /api/v1/posts`; stage results arrive by webhook (`stage.settled`, with `uri` and no `postId`).',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        bodyLimit({
            maxSize: 8 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: { body: { content: { 'application/json': { schema: RegisterRemotePostRequestSchema } } } },
    responses: {
        200: jsonResponse(RemotePostViewSchema, 'Already registered (unchanged, or updated to the new CID)'),
        201: jsonResponse(RemotePostViewSchema, 'Registered'),
        400: errorResponse('Invalid body, or a URI that is not a plain audio post record (`REMOTE_URI_UNSUPPORTED`)'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('The repo says the record does not exist (`REMOTE_RECORD_NOT_FOUND`)'),
        409: errorResponse("The record's CID is not `cid` (`REMOTE_CID_MISMATCH`), or its audio is private here (`REMOTE_BLOB_PRIVATE`)"),
        422: errorResponse('Not an audio post, or its blob does not check out (`REMOTE_RECORD_INVALID`)'),
        503: errorResponse('The repo could not be read right now (`REMOTE_REPO_UNREACHABLE`)'),
    },
});

app.openapi(putRoute, async (c) => {
    const body = c.req.valid('json');
    const originAppId = getOriginAppId(c);
    const service = servicesFor(c.env).remotePostService;
    const resolved = resolveInitialProcessing(originAppId, body.processing);
    const { row, outcome, dispatch } = await service.register(originAppId, {
        uri: body.uri,
        cid: body.cid,
        ...(resolved ? { processing: resolved } : {}),
    });
    if (dispatch) await dispatchRemoteProcessing(originAppId, body.uri, env(c));
    // Re-read so the view reflects any inline processing results.
    const fresh = dispatch ? await service.get(originAppId, body.uri) : row;
    const [view] = await service.hydrate(originAppId, [fresh]);
    return outcome === 'created'
        ? c.json({ success: true as const, data: view }, 201)
        : c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// GET /?uri= — one post
// ---------------------------------------------------------------------------

const getRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['Remote posts'],
    summary: 'Get a registered remote post',
    description:
        "Returns one of the calling tenant's registered remote posts. Another tenant's registration reads as 404 " +
        '(`REMOTE_POST_NOT_FOUND`). A registration that was removed, by the tenant or because the record was deleted ' +
        'from its repo, is 410 (`REMOTE_POST_DELETED`). A post whose repo has been unreachable for 30 days has ' +
        '`available: false` and no `embed`.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
    ] as const,
    request: { query: UriQuerySchema },
    responses: {
        200: jsonResponse(RemotePostViewSchema, 'The post'),
        400: errorResponse('Invalid uri'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Not registered by this tenant (`REMOTE_POST_NOT_FOUND`)'),
        410: errorResponse('Registration removed (`REMOTE_POST_DELETED`)'),
    },
});

app.openapi(getRoute, async (c) => {
    const { uri } = c.req.valid('query');
    const originAppId = getOriginAppId(c);
    const service = servicesFor(c.env).remotePostService;
    const [view] = await service.hydrate(originAppId, [await service.get(originAppId, uri)]);
    return c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// GET /thread?root= — replies under a root
// ---------------------------------------------------------------------------

const threadRoute = createRoute({
    method: 'get',
    path: '/thread',
    tags: ['Remote posts'],
    summary: 'Get the registered replies under a root',
    description:
        "The calling tenant's registered remote posts whose `reply.root` is `root`, oldest first. Only what was " +
        'registered: Antiphony does not crawl for replies. The root itself is included on the first page when it is ' +
        'a registered remote post.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
    ] as const,
    request: {
        query: z.object({
            root: RemotePostUriSchema.openapi({ description: 'The thread root URI' }),
            limit: z.coerce.number().int().min(1).max(100).optional().openapi({ description: '1–100 (default 50)' }),
            cursor: z.string().max(512).optional().openapi({ description: '`nextCursor` from the previous page' }),
        }),
    },
    responses: {
        200: jsonResponse(RemoteThreadViewSchema, 'One page of the thread'),
        400: errorResponse('Invalid root, limit or cursor'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(threadRoute, async (c) => {
    const { root, limit, cursor } = c.req.valid('query');
    const originAppId = getOriginAppId(c);
    const service = servicesFor(c.env).remotePostService;
    const page = await service.thread(originAppId, root, { limit: limit ?? 50, ...(cursor ? { cursor } : {}) });
    const [rootView, replies] = await Promise.all([
        page.root ? service.hydrate(originAppId, [page.root]).then(([v]) => v) : Promise.resolve(null),
        service.hydrate(originAppId, page.replies),
    ]);
    return c.json({ success: true as const, data: { root: rootView, replies, nextCursor: page.nextCursor } }, 200);
});

// ---------------------------------------------------------------------------
// PATCH /?uri= — request processing
// ---------------------------------------------------------------------------

const patchRoute = createRoute({
    method: 'patch',
    path: '/',
    tags: ['Remote posts'],
    summary: 'Request processing on a remote post',
    description:
        '(Re)runs audio processing (denoise / trim / transcribe / waveform) on a registered remote post, as `PATCH ' +
        '/api/v1/posts/{postId}` does for a hosted one. The body accepts only a `processing` opt-in. Returns the view.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        bodyLimit({
            maxSize: 8 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: {
        query: UriQuerySchema,
        body: { content: { 'application/json': { schema: PatchRemotePostRequestSchema } } },
    },
    responses: {
        200: jsonResponse(RemotePostViewSchema, 'Processing requested; the view'),
        400: errorResponse('No processing stage requested'),
        401: errorResponse('Not authenticated'),
        404: errorResponse('Not registered by this tenant (`REMOTE_POST_NOT_FOUND`)'),
        410: errorResponse('Registration removed (`REMOTE_POST_DELETED`)'),
    },
});

app.openapi(patchRoute, async (c) => {
    const { uri } = c.req.valid('query');
    const body = c.req.valid('json');
    const originAppId = getOriginAppId(c);
    const resolved = resolveInitialProcessing(originAppId, body.processing);
    if (!resolved) return c.json(errorEnvelope(c, 'Request must enable at least one processing stage'), 400);

    const service = servicesFor(c.env).remotePostService;
    const { dispatch } = await service.requestProcessing(originAppId, uri, resolved);
    if (dispatch) await dispatchRemoteProcessing(originAppId, uri, env(c));
    const [view] = await service.hydrate(originAppId, [await service.get(originAppId, uri)]);
    return c.json({ success: true as const, data: view }, 200);
});

// ---------------------------------------------------------------------------
// DELETE /?uri= — remove
// ---------------------------------------------------------------------------

const deleteRoute = createRoute({
    method: 'delete',
    path: '/',
    tags: ['Remote posts'],
    summary: 'Remove a registered remote post',
    description:
        "Removes the calling tenant's registration and Antiphony's copy: the index entry, the transcript, and the " +
        'audio and its variants, unless another post still uses them. The record in its own repo is untouched. A ' +
        'content-free ledger entry is kept, so a later read is 410. Idempotent: `deleted` is false when there was ' +
        'no registration. Antiphony also removes a registration on its own once the record is gone from its repo, ' +
        'and sends `remote.gone`.',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
    ] as const,
    request: { query: UriQuerySchema },
    responses: {
        200: jsonResponse(DeleteRemotePostResultSchema, 'Whether a registration was removed'),
        400: errorResponse('Invalid uri'),
        401: errorResponse('Not authenticated'),
    },
});

app.openapi(deleteRoute, async (c) => {
    const { uri } = c.req.valid('query');
    const deleted = await servicesFor(c.env).remotePostService.delete(getOriginAppId(c), uri);
    return c.json({ success: true as const, data: { uri, deleted } }, 200);
});

export { app as remotePostsRoute };
