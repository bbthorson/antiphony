import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { XRPC_NSID } from 'shared/nsid';
import { CreateAudioPostRequestSchema, PatchAudioPostRequestSchema } from 'shared/api-codecs';
import {
    RecheckRemoteSpaceRequestSchema,
    RegisterRemotePostRequestSchema,
    ReprocessRemotePostRequestSchema,
    UnregisterRemotePostRequestSchema,
} from 'shared/types/remote-posts';
import { postUriOf } from '@antiphony/core/services/audio-posts';
import { rateLimit, RATE_LIMITS, actingActorKey } from '../../../middleware/rate-limit.js';
import { requireAuth, requireServiceToken } from '../../../middleware/auth.js';
import { servicesFor } from '../../../composition.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { getAppDid } from '../../../lib/app-did.js';
import { audioPlaybackUrl, signedAudioPlaybackUrl } from '../../../lib/audio-url.js';
import { resolveInitialProcessing, hasPendingStage, dispatchProcessing } from '../../../lib/audio-processing.js';
import { xrpcError, xrpcErrorHandler, xrpcSymbol } from './errors.js';
import {
    GetRemotePostQuerySchema,
    GetRemotePostsQuerySchema,
    GetRemoteThreadQuerySchema,
    ListRemotePostsQuerySchema,
    getRemotePost,
    getRemotePosts,
    getRemoteThread,
    listRemotePosts,
    recheckRemoteSpace,
    registerRemotePost,
    reprocessRemotePost,
    unregisterRemotePost,
} from '../remote-post-operations.js';

/**
 * The XRPC inbound adapter, mounted at `/xrpc/*`
 * (specs/xrpc-and-atproto-lex-strategy.md §4–5).
 *
 * XRPC is plain HTTP — `GET /xrpc/<nsid>` for a query, `POST /xrpc/<nsid>` for
 * a procedure — so in this codebase's hexagonal layout it is simply a second
 * inbound adapter over the same domain services the REST adapter calls. Nothing
 * here reaches past a domain service (`audioPostService`, and `remotePostService`
 * through `../remote-post-operations.ts`, which the REST twins of the
 * remote-post methods call too); a handler that needed its own storage access
 * would be a sign the translation had leaked into the domain.
 *
 * ## What differs from REST, and what deliberately does not
 *
 * **Differs:** the error dialect (`{ error, message }` — see `./errors.ts`) and
 * the addressing (a flat method NSID with query parameters, rather than nested
 * resource paths).
 *
 * **Does not differ:** authentication, tenancy, and rate limiting. These routes
 * mount the same `requireServiceToken` / `requireAuth` / `rateLimit` middleware
 * as REST, so `originAppId` is derived from the credential and never from a
 * request parameter. A caller authenticated as app `voxpop` reads and writes
 * `voxpop` records here exactly as it does under `/api/v1/*`. XRPC's own
 * inter-service JWT auth is **out of scope**: Antiphony is not a PDS, and its
 * callers are applications, not federated servers (§5.3).
 *
 * ## The lexicon documents are the contract
 *
 * Each method below has a lexicon document under `lexicons/dev/antiphony/audio/`
 * — `getPost.json`, `getThread.json`, and so on — with the shared view and
 * request shapes in `defs.json`. Those are what a client codegens against, and
 * they are the reason a route here should not quietly grow a field: the
 * lexicon-parity oracle in `@antiphony/shared` holds the Zod schemas to those
 * definitions, and `npm run test:lexicons` validates the documents themselves.
 *
 * Adding or changing a method therefore means touching three things together —
 * the lexicon document, the Zod schema, and the handler. The tests fail if only
 * two of them move: shared's lexicon-parity test compares every record, view
 * and procedure input (and fails on a lexicon shape nobody compares), and
 * `lexicon-params.test.ts` here compares each query's parameters with the
 * schemas below.
 */

/** Registered so `c.req.query()` parsing stays declarative and consistent. */
export const GetPostQuerySchema = z.object({
    id: z.string().min(1),
});

export const GetThreadQuerySchema = z.object({
    id: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
});

export const GetPlaybackUrlQuerySchema = z.object({
    cid: z.string().min(1),
});

/**
 * `reprocessPost` takes the post id in the body alongside the processing
 * opt-in, rather than as a query parameter: it is a procedure, and a procedure's
 * input is its body. This is the one place the XRPC surface is shaped
 * differently from its REST counterpart (`PATCH /api/v1/posts/{postId}`, where
 * the id is a path segment).
 */
const ReprocessBodySchema = PatchAudioPostRequestSchema.extend({
    id: z.string().min(1),
});

/**
 * The rkey (post id) at the tail of a post `at://` uri — the inverse of
 * `buildPostUri`, and the pagination cursor for a thread page.
 */
function rkeyFromUri(uri: string): string {
    return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * Parse a query string or a procedure's body against a schema, answering in
 * the XRPC dialect on failure. Returns the parsed value, or a `Response` to
 * return as-is.
 */
function parseInput<T extends z.ZodTypeAny>(
    c: Context,
    schema: T,
    raw: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; response: Response } {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, value: result.data };
    // XRPC has no `issues` field, so the offending parameters go in the message
    // — otherwise the caller gets "InvalidRequest" with nothing to act on.
    const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    return {
        ok: false,
        response: c.json(xrpcError('InvalidRequest', detail), 400),
    };
}

/**
 * The body limit for a procedure, refused in the XRPC dialect. The sizes are
 * the REST twins' (`rest/remote-posts.ts`), so a body one surface accepts the
 * other does too.
 */
function xrpcBodyLimit(maxSize: number) {
    return bodyLimit({
        maxSize,
        onError: (c) => c.json(xrpcError(xrpcSymbol(413), 'Request body too large'), 413),
    });
}

export function xrpcRoute(): Hono {
    const app = new Hono();

    // The XRPC error dialect. Mounted here rather than on the parent app so
    // REST keeps its own envelope; Hono routes throws from these routes (and
    // from the middleware below) to this handler.
    app.onError(xrpcErrorHandler);

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getPost
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetPost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, GetPostQuerySchema, { id: c.req.query('id') });
            if (!parsed.ok) return parsed.response;

            const view = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.getPostView(
                getOriginAppId(c),
                parsed.value.id,
                c.get('viewerUid'),
            );
            if (!view) {
                return c.json(xrpcError('RecordNotFound', `Post not found: ${parsed.value.id}`), 404);
            }
            return c.json(view);
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getThread
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetThread}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, GetThreadQuerySchema, {
                id: c.req.query('id'),
                limit: c.req.query('limit'),
                cursor: c.req.query('cursor'),
            });
            if (!parsed.ok) return parsed.response;

            const { id, limit, cursor } = parsed.value;
            const originAppId = getOriginAppId(c);
            const viewerUid = c.get('viewerUid');

            // Resolve the parent first, for the same two reasons as the REST
            // thread route: the reply query keys on the parent's `at://` uri,
            // and a missing parent must read as 404 rather than an empty list.
            const parent = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.getPostView(originAppId, id, viewerUid);
            if (!parent) {
                return c.json(xrpcError('RecordNotFound', `Post not found: ${id}`), 404);
            }

            const replies = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.getReplies(originAppId, parent.uri, viewerUid, {
                limit,
                cursorId: cursor,
            });

            return c.json({
                parent,
                replies,
                // Only a full, non-empty page can have a next one behind it.
                cursor:
                    replies.length > 0 && replies.length === limit
                        ? rkeyFromUri(replies[replies.length - 1].uri)
                        : null,
            });
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getPlaybackUrl
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetPlaybackUrl}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, GetPlaybackUrlQuerySchema, { cid: c.req.query('cid') });
            if (!parsed.ok) return parsed.response;

            // Tenancy-scoped by construction: the blob path is built from the
            // credential's `originAppId`, so a cid from another tenant resolves
            // to a path this caller's app never wrote.
            const originAppId = getOriginAppId(c);
            const { cid } = parsed.value;
            // Audio stored in a space plays only from a signed, expiring URL
            // (specs/spaces.md). The caller is the tenant, which is the space's
            // managing app: deciding who may listen is its job, and asking here
            // is that decision. A blob that isn't stored at all gets the plain
            // URL, as before; the proxy 404s it.
            const stored = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostDeps.getBlobSpace(
                originAppId,
                cid,
            );
            const url = stored?.space
                ? await signedAudioPlaybackUrl(originAppId, cid)
                : audioPlaybackUrl(originAppId, cid);
            if (!url) {
                return c.json(
                    xrpcError('RecordNotFound', `No playable audio for cid: ${parsed.value.cid}`),
                    404,
                );
            }
            return c.json({ url });
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.listRemotePosts
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.ListRemotePosts}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, ListRemotePostsQuerySchema, {
                repo: c.req.query('repo'),
                space: c.req.query('space'),
                kind: c.req.query('kind'),
                limit: c.req.query('limit'),
                cursor: c.req.query('cursor'),
            });
            if (!parsed.ok) return parsed.response;
            // `{ posts, cursor? }`: `cursor` is left out on the last page, as
            // atproto lists do, rather than sent as null.
            return c.json(
                await listRemotePosts(c.env as Record<string, unknown> | undefined, getOriginAppId(c), parsed.value),
            );
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getRemotePosts
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetRemotePosts}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            // An array parameter is the name repeated: `?uris=…&uris=…`.
            const uris = c.req.queries('uris');
            const result = GetRemotePostsQuerySchema.safeParse({ uris });
            if (!result.success) {
                const detail = result.error.issues
                    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                    .join('; ');
                return c.json(xrpcError('InvalidRequest', detail), 400);
            }
            return c.json(
                await getRemotePosts(c.env as Record<string, unknown> | undefined, getOriginAppId(c), result.data.uris),
            );
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getRemotePost
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetRemotePost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, GetRemotePostQuerySchema, { uri: c.req.query('uri') });
            if (!parsed.ok) return parsed.response;
            // Not registered is `RemotePostNotFound` (404), removed is
            // `RemotePostDeleted` (410): thrown by the service, named in `onError`.
            return c.json(
                await getRemotePost(c.env as Record<string, unknown> | undefined, getOriginAppId(c), parsed.value.uri),
            );
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getRemoteThread
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetRemoteThread}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.readAggregate),
        rateLimit(RATE_LIMITS.read, { keyBy: actingActorKey }),
        async (c) => {
            const parsed = parseInput(c, GetRemoteThreadQuerySchema, {
                root: c.req.query('root'),
                limit: c.req.query('limit'),
                cursor: c.req.query('cursor'),
            });
            if (!parsed.ok) return parsed.response;
            const page = await getRemoteThread(c.env as Record<string, unknown> | undefined, getOriginAppId(c), parsed.value);
            // The atproto list shape: `root` and `cursor` are left out when
            // there is nothing to say, rather than sent as null as REST does.
            return c.json({
                ...(page.root ? { root: page.root } : {}),
                replies: page.replies,
                ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
            });
        },
    );

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.tenant.getStats
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetStats}`,
        // Tenant-level and viewer-less: the service token names the tenant, and
        // an acting actor, if one is sent, is ignored. The read limit is keyed
        // by client IP, as the spec has it, since there is no actor to key on.
        requireServiceToken(),
        rateLimit(RATE_LIMITS.read),
        async (c) => c.json(await servicesFor(c.env as Record<string, unknown> | undefined).tenantStatsService.getStats(getOriginAppId(c))),
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.createPost
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.CreatePost}`,
        requireAuth(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.write, { keyBy: actingActorKey }),
        async (c) => {
            const uid = c.get('viewerUid')!;

            // A malformed body throws; `onError` renders it as InvalidRequest.
            const raw: unknown = await c.req.json();
            const validation = CreateAudioPostRequestSchema.safeParse(raw);
            if (!validation.success) {
                return c.json(
                    xrpcError('InvalidRequest', 'Payload failed schema validation'),
                    400,
                );
            }

            const { text, title, embed, reply, langs, selfLabels, processing, space, spaceAuthor, authority } = validation.data;
            const originAppId = getOriginAppId(c);
            const initialProcessing = resolveInitialProcessing(originAppId, processing);

            const created = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.createPost({
                originAppId,
                authorId: uid,
                authorDid: c.get('actingActorDid') ?? undefined,
                text,
                title,
                embed,
                reply,
                langs,
                selfLabels,
                processing: initialProcessing,
                space,
                spaceAuthor,
                authority,
            });

            if (hasPendingStage(initialProcessing)) {
                await dispatchProcessing(originAppId, created.id, c.env as Record<string, unknown> | undefined);
            }

            // `{ uri, cid }` — a StrongRef, the atproto convention for "what I
            // just wrote" (cf. com.atproto.repo.createRecord). The REST route
            // answers `{ postId }` instead; both name the same record, and the
            // uri is built here rather than re-read so a create still costs one
            // write and no extra read.
            return c.json({
                uri: postUriOf(created, getAppDid),
                cid: created.cid,
            });
        },
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.reprocessPost
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.ReprocessPost}`,
        requireAuth(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.write, { keyBy: actingActorKey }),
        async (c) => {
            const uid = c.get('viewerUid')!;

            const raw: unknown = await c.req.json();
            const validation = ReprocessBodySchema.safeParse(raw);
            if (!validation.success) {
                return c.json(
                    xrpcError('InvalidRequest', 'Payload failed schema validation'),
                    400,
                );
            }

            const { id, processing } = validation.data;
            const originAppId = getOriginAppId(c);

            const resolved = resolveInitialProcessing(originAppId, processing);
            if (!resolved) {
                return c.json(
                    xrpcError('InvalidRequest', 'Request must enable at least one processing stage'),
                    400,
                );
            }

            // Author check and persistence happen in the service, which throws
            // the 403/404/400 this adapter's `onError` renders.
            await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.setProcessing(originAppId, id, uid, resolved);

            if (hasPendingStage(resolved)) {
                await dispatchProcessing(originAppId, id, c.env as Record<string, unknown> | undefined);
            }

            const view = await servicesFor(c.env as Record<string, unknown> | undefined).audioPostService.getPostView(originAppId, id, uid);
            if (!view) {
                return c.json(xrpcError('RecordNotFound', `Post not found: ${id}`), 404);
            }
            return c.json(view);
        },
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.registerPost
    // -----------------------------------------------------------------------
    // The remote-post procedures are tenant-level, as their REST twins are: a
    // remote post has no author facet here, so a service token is enough and
    // an acting actor, if sent, only keys the burst limit.
    app.post(
        `/${XRPC_NSID.RegisterPost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        // Room for a pushed space record, as on `PUT /api/v1/remote-posts`.
        xrpcBodyLimit(64 * 1024),
        async (c) => {
            const parsed = parseInput(c, RegisterRemotePostRequestSchema, await c.req.json());
            if (!parsed.ok) return parsed.response;
            // REST answers 201 for a first registration and 200 for a repeat or
            // an edit. XRPC has no created status, so every success is 200 and
            // `outcome` is not surfaced.
            const { view } = await registerRemotePost(
                c.env as Record<string, unknown> | undefined,
                getOriginAppId(c),
                parsed.value,
            );
            return c.json(view);
        },
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.reprocessRemotePost
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.ReprocessRemotePost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        xrpcBodyLimit(8 * 1024),
        async (c) => {
            const parsed = parseInput(c, ReprocessRemotePostRequestSchema, await c.req.json());
            if (!parsed.ok) return parsed.response;
            const { uri, processing } = parsed.value;
            return c.json(
                await reprocessRemotePost(c.env as Record<string, unknown> | undefined, getOriginAppId(c), uri, processing),
            );
        },
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.unregisterPost
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.UnregisterPost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        // REST's DELETE has no body to limit; this one carries only a URI, so
        // it gets the smallest limit any remote-post route has.
        xrpcBodyLimit(8 * 1024),
        async (c) => {
            const parsed = parseInput(c, UnregisterRemotePostRequestSchema, await c.req.json());
            if (!parsed.ok) return parsed.response;
            return c.json(
                await unregisterRemotePost(c.env as Record<string, unknown> | undefined, getOriginAppId(c), parsed.value.uri),
            );
        },
    );

    // -----------------------------------------------------------------------
    // Procedure: dev.antiphony.audio.recheckRemoteSpace
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.RecheckRemoteSpace}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.writeAggregate),
        rateLimit(RATE_LIMITS.burst, { keyBy: actingActorKey }),
        xrpcBodyLimit(32 * 1024),
        async (c) => {
            const parsed = parseInput(c, RecheckRemoteSpaceRequestSchema, await c.req.json());
            if (!parsed.ok) return parsed.response;
            return c.json(
                await recheckRemoteSpace(c.env as Record<string, unknown> | undefined, getOriginAppId(c), parsed.value),
            );
        },
    );

    return app;
}
