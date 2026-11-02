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
 * Remote posts, mounted at `/api/v1/remote-posts` (specs/audio-service-mode.md):
 * audio whose `dev.antiphony.audio.post` record lives in a repo Antiphony
 * doesn't host, such as a player's PDS or a group's repo on its group host.
 * Public repo records are fetched here (Phase A). Space records are pushed by
 * the tenant, record body and bytes, because Antiphony can't read a space
 * before Phase C; for those the tenant's DELETE is the only deletion signal.
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
    uri: RemotePostUriSchema.openapi({
        description:
            'The record URI: `at://{did}/dev.antiphony.audio.post/{rkey}`, or for a space record ' +
            '`at://{authority}/space/{type}/{skey}/{authorDid}/dev.antiphony.audio.post/{rkey}`.',
    }),
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
        '`REMOTE_REPO_UNREACHABLE`. If the tenant already uploaded the same bytes they are not downloaded again ' +
        '(`bytesFrom: "upload"` requires that), except that bytes stored private for a space are downloaded from the ' +
        "record's repo and checked, then turned public: a verified public record makes its audio public here, for " +
        'good, on the original and every processed variant.\n\n' +
        '**Space records** (`at://{authority}/space/{type}/{skey}/{authorDid}/dev.antiphony.audio.post/{rkey}`) are ' +
        "pushed, because Antiphony can't read a space yet. Send `record`, the body as the tenant read it, and first " +
        'upload its audio with `remoteSpace` naming the same space (`POST /api/v1/audio/upload`). Antiphony checks ' +
        'that `record` hashes to `cid` and is an audio post (422 `REMOTE_RECORD_INVALID`), and that its blob is an ' +
        'upload of this tenant stored private for that space (422 if not uploaded; 409 `REMOTE_BLOB_SPACE_MISMATCH` ' +
        'if it is private for another space, or public with no verified public record referencing it). That proves ' +
        "content, not that the tenant can read the space: the view says `verified: \"pushed\"`. A pushed record's " +
        'audio stays private and plays from signed, expiring URLs only. **Antiphony cannot see a space record ' +
        "deleted, so the tenant's `DELETE` is the only signal** (`deletionCheck: \"tenant\"` in the view): a " +
        "tenant that can't commit to sending it shouldn't register members' records this way. `bytesFrom: " +
        '"fetch"` on a space record is 400 `REMOTE_URI_UNSUPPORTED`; `record` missing for a space record, or sent ' +
        'for a repo record, is 400 `REMOTE_REQUEST_INVALID`.\n\n' +
        'Repeating a registration is a no-op (200); a new `cid` for the same URI takes the edit (200). ' +
        '`processing` opts into stages as on `POST /api/v1/posts`; stage results arrive by webhook ' +
        '(`stage.settled`, with `uri` and no `postId`).',
    middleware: [
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        // Room for a pushed space record: up to 3000 characters of text and a
        // 1000-point waveform, with headroom for escaping and unknown fields.
        bodyLimit({
            maxSize: 64 * 1024,
            onError: (c) => c.json(errorEnvelope(c, 'Request body too large'), 413),
        }),
    ] as const,
    request: { body: { content: { 'application/json': { schema: RegisterRemotePostRequestSchema } } } },
    responses: {
        200: jsonResponse(RemotePostViewSchema, 'Already registered (unchanged, or updated to the new CID)'),
        201: jsonResponse(RemotePostViewSchema, 'Registered'),
        400: errorResponse(
            'Invalid body; a URI that is not an audio post record, or a space record to fetch (`REMOTE_URI_UNSUPPORTED`); ' +
                '`record` missing for a space record or sent for a repo record (`REMOTE_REQUEST_INVALID`)',
        ),
        401: errorResponse('Not authenticated'),
        404: errorResponse('The repo says the record does not exist (`REMOTE_RECORD_NOT_FOUND`)'),
        409: errorResponse(
            "The record's CID is not `cid` (`REMOTE_CID_MISMATCH`), or a space record's audio is not stored private for " +
                'its space (`REMOTE_BLOB_SPACE_MISMATCH`)',
        ),
        422: errorResponse(
            'Not an audio post, a pushed record that does not hash to `cid`, or a blob that does not check out or was ' +
                'not uploaded (`REMOTE_RECORD_INVALID`)',
        ),
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
        ...(body.bytesFrom ? { bytesFrom: body.bytesFrom } : {}),
        ...(body.record ? { record: body.record } : {}),
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
        'no registration. For a repo record Antiphony also removes a registration on its own once the record is gone ' +
        "from its repo, and sends `remote.gone`. **A space record can't be read here before Phase C, so this DELETE " +
        'is the only way its copy goes**: send it when the member deletes the record.',
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
