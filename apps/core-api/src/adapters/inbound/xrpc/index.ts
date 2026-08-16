import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { XRPC_NSID } from 'shared/nsid';
import { CreateAudioPostRequestSchema, PatchAudioPostRequestSchema } from 'shared/api-codecs';
import { buildPostUri } from '@antiphony/core/services/audio-posts';
import { rateLimit, RATE_LIMITS } from '../../../middleware/rate-limit.js';
import { requireAuth, requireServiceToken } from '../../../middleware/auth.js';
import { originLock } from '../../../middleware/origin-lock.js';
import { audioPostService } from '../../outbound/firebase/core-services-firebase.js';
import { getOriginAppId } from '../../../lib/origin-app.js';
import { getAppDid } from '../../../lib/app-did.js';
import { audioPlaybackUrl } from '../../../lib/audio-url.js';
import { resolveInitialProcessing, hasPendingStage, dispatchProcessing } from '../../../lib/audio-processing.js';
import { xrpcError, xrpcErrorHandler } from './errors.js';

/**
 * The XRPC inbound adapter, mounted at `/xrpc/*`
 * (specs/xrpc-and-atproto-lex-strategy.md §4–5).
 *
 * XRPC is plain HTTP — `GET /xrpc/<nsid>` for a query, `POST /xrpc/<nsid>` for
 * a procedure — so in this codebase's hexagonal layout it is simply a second
 * inbound adapter over the same domain services the REST adapter calls. Nothing
 * here reaches past `audioPostService`; a handler that needed its own storage
 * access would be a sign the translation had leaked into the domain.
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
 * two of them move.
 */

/** Registered so `c.req.query()` parsing stays declarative and consistent. */
const GetPostQuerySchema = z.object({
    id: z.string().min(1),
});

const GetThreadQuerySchema = z.object({
    id: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
});

const GetPlaybackUrlQuerySchema = z.object({
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
 * Parse a query string against a schema, answering in the XRPC dialect on
 * failure. Returns the parsed value, or a `Response` to return as-is.
 */
function parseQuery<T extends z.ZodTypeAny>(
    c: Context,
    schema: T,
    raw: Record<string, string | undefined>,
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

export function xrpcRoute(): Hono {
    const app = new Hono();

    // The XRPC error dialect. Mounted here rather than on the parent app so
    // REST keeps its own envelope; Hono routes throws from these routes (and
    // from the middleware below) to this handler.
    app.onError(xrpcErrorHandler);

    // The origin lock, same as `/api/v1/*` — this surface reaches the same
    // domain services, so leaving it off would make `/xrpc/*` the one way in
    // that skips the CDN. It is registered HERE, not next to the REST lock in
    // app.ts, because Hono dispatches a throw to the error handler of the app
    // the middleware was registered on: declared on the parent, a refusal would
    // reach an XRPC caller wearing the REST envelope.
    app.use('*', originLock());

    // -----------------------------------------------------------------------
    // Query: dev.antiphony.audio.getPost
    // -----------------------------------------------------------------------
    app.get(
        `/${XRPC_NSID.GetPost}`,
        requireServiceToken(),
        rateLimit(RATE_LIMITS.read),
        async (c) => {
            const parsed = parseQuery(c, GetPostQuerySchema, { id: c.req.query('id') });
            if (!parsed.ok) return parsed.response;

            const view = await audioPostService.getPostView(
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
        rateLimit(RATE_LIMITS.read),
        async (c) => {
            const parsed = parseQuery(c, GetThreadQuerySchema, {
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
            const parent = await audioPostService.getPostView(originAppId, id, viewerUid);
            if (!parent) {
                return c.json(xrpcError('RecordNotFound', `Post not found: ${id}`), 404);
            }

            const replies = await audioPostService.getReplies(originAppId, parent.uri, viewerUid, {
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
        rateLimit(RATE_LIMITS.read),
        async (c) => {
            const parsed = parseQuery(c, GetPlaybackUrlQuerySchema, { cid: c.req.query('cid') });
            if (!parsed.ok) return parsed.response;

            // Tenancy-scoped by construction: the blob path is built from the
            // credential's `originAppId`, so a cid from another tenant resolves
            // to a path this caller's app never wrote.
            const url = audioPlaybackUrl(getOriginAppId(c), parsed.value.cid);
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
    // Procedure: dev.antiphony.audio.createPost
    // -----------------------------------------------------------------------
    app.post(
        `/${XRPC_NSID.CreatePost}`,
        requireAuth(),
        rateLimit(RATE_LIMITS.write),
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

            const { text, title, embed, reply, langs, selfLabels, processing } = validation.data;
            const originAppId = getOriginAppId(c);
            const initialProcessing = resolveInitialProcessing(originAppId, processing);

            const created = await audioPostService.createPost({
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
            });

            if (hasPendingStage(initialProcessing)) {
                await dispatchProcessing(originAppId, created.id);
            }

            // `{ uri, cid }` — a StrongRef, the atproto convention for "what I
            // just wrote" (cf. com.atproto.repo.createRecord). The REST route
            // answers `{ postId }` instead; both name the same record, and the
            // uri is built here rather than re-read so a create still costs one
            // write and no extra read.
            return c.json({
                uri: buildPostUri(getAppDid(originAppId), created.id),
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
        rateLimit(RATE_LIMITS.write),
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
            await audioPostService.setProcessing(originAppId, id, uid, resolved);

            if (hasPendingStage(resolved)) {
                await dispatchProcessing(originAppId, id);
            }

            const view = await audioPostService.getPostView(originAppId, id, uid);
            if (!view) {
                return c.json(xrpcError('RecordNotFound', `Post not found: ${id}`), 404);
            }
            return c.json(view);
        },
    );

    return app;
}
