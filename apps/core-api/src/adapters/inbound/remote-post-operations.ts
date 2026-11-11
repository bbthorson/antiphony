import { z } from 'zod';
import { ServiceError } from 'shared/errors';
import { DidStringSchema } from 'shared/types/dids';
import type { ProcessingRequest } from 'shared/types/processing';
import {
    MAX_REMOTE_POSTS_BATCH,
    RemotePostUriSchema,
    RemoteSpaceUriSchema,
    type DeleteRemotePostResult,
    type RecheckRemoteSpaceRequest,
    type RecheckRemoteSpaceResult,
    type RegisterRemotePostRequest,
    type RemotePostView,
    type RemoteThreadView,
} from 'shared/types/remote-posts';
import { parseRemoteSpaceUri, type RegisterResult } from '@antiphony/core/services/remote-posts';
import { servicesFor } from '../../composition.js';
import { dispatchRemoteProcessing, resolveInitialProcessing } from '../../lib/audio-processing.js';

/**
 * Every remote-post operation (specs/audio-service-mode.md), once, for both
 * inbound adapters. The REST routes (`rest/remote-posts.ts`) and the XRPC
 * methods (`xrpc/index.ts`) parse their own input and render their own
 * output, envelope or bare body, and in between call the functions here, so
 * the two surfaces can't answer differently: what is registered, what is
 * dispatched for processing, and what a refusal is.
 *
 * Lexicon-first: the lexicons under `lexicons/dev/antiphony/audio/` are the
 * contract, and the query schemas below are what the XRPC handlers parse a
 * query string with (`xrpc/lexicon-params.test.ts` holds them to the
 * lexicons). The shapes follow atproto's own lists
 * (`com.atproto.repo.listRecords`, `app.bsky.feed.getPosts`): `limit` and
 * `cursor` in, a named array and `cursor` out, and a batch read that leaves
 * out what it doesn't find.
 *
 * Errors are the service's `ServiceError`s, thrown through, so each adapter's
 * `onError` renders them in its own dialect.
 */

/** `getRemotePost` parameters. */
export const GetRemotePostQuerySchema = z.object({
    uri: RemotePostUriSchema,
});

/**
 * `getRemoteThread` parameters. The REST route keeps its own schema, with no
 * default on `limit`, because that schema is what its OpenAPI document is
 * generated from; both default to 50 in `getRemoteThread` below.
 */
export const GetRemoteThreadQuerySchema = z.object({
    root: RemotePostUriSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
});

/** `listRemotePosts` parameters, as a query string carries them. */
export const ListRemotePostsQuerySchema = z.object({
    repo: DidStringSchema.optional(),
    space: RemoteSpaceUriSchema.optional(),
    kind: z.enum(['prompt', 'reply']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional(),
});
export type ListRemotePostsQuery = z.infer<typeof ListRemotePostsQuerySchema>;

/**
 * `getRemotePosts` parameters. `uris` is repeated in the query string, and a
 * single value arrives as a bare string, so it is read as a list of one.
 */
export const GetRemotePostsQuerySchema = z.object({
    uris: z.preprocess(
        (value) => (typeof value === 'string' ? [value] : value),
        z.array(RemotePostUriSchema).min(1).max(MAX_REMOTE_POSTS_BATCH),
    ),
});
export type GetRemotePostsQuery = z.infer<typeof GetRemotePostsQuerySchema>;

type Env = Record<string, unknown> | undefined;

/**
 * Register a record held elsewhere, dispatch processing if a stage is pending,
 * and answer the view. `outcome` is the service's, so REST can tell a first
 * registration (201) from a repeat or an edit (200); XRPC has no such
 * convention and answers 200 either way.
 */
export async function registerRemotePost(
    env: Env,
    originAppId: string,
    body: RegisterRemotePostRequest,
): Promise<{ view: RemotePostView; outcome: RegisterResult['outcome'] }> {
    const service = servicesFor(env).remotePostService;
    const resolved = resolveInitialProcessing(originAppId, body.processing);
    const { row, outcome, dispatch } = await service.register(originAppId, {
        uri: body.uri,
        cid: body.cid,
        ...(resolved ? { processing: resolved } : {}),
        ...(body.bytesFrom ? { bytesFrom: body.bytesFrom } : {}),
        ...(body.record ? { record: body.record } : {}),
        ...(body.delegationToken ? { delegationToken: body.delegationToken } : {}),
        ...(body.clientAttestation ? { clientAttestation: body.clientAttestation } : {}),
    });
    if (dispatch) await dispatchRemoteProcessing(originAppId, body.uri, env);
    // Re-read so the view reflects any inline processing results.
    const fresh = dispatch ? await service.get(originAppId, body.uri) : row;
    const [view] = await service.hydrate(originAppId, [fresh]);
    return { view, outcome };
}

/** One registered post, hydrated; 404 or 410 from the service otherwise. */
export async function getRemotePost(env: Env, originAppId: string, uri: string): Promise<RemotePostView> {
    const service = servicesFor(env).remotePostService;
    const [view] = await service.hydrate(originAppId, [await service.get(originAppId, uri)]);
    return view;
}

/**
 * One page of the registered replies under `root`, with the root itself on
 * the first page when it is registered. Answered in the REST shape (nulls);
 * the XRPC handler leaves the null fields out, as atproto lists do.
 */
export async function getRemoteThread(
    env: Env,
    originAppId: string,
    query: { root: string; limit?: number; cursor?: string },
): Promise<RemoteThreadView> {
    const service = servicesFor(env).remotePostService;
    const page = await service.thread(originAppId, query.root, {
        limit: query.limit ?? 50,
        ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const [root, replies] = await Promise.all([
        page.root ? service.hydrate(originAppId, [page.root]).then(([v]) => v) : Promise.resolve(null),
        service.hydrate(originAppId, page.replies),
    ]);
    return { root, replies, nextCursor: page.nextCursor };
}

/** One page of the tenant's registered posts, hydrated. */
export async function listRemotePosts(
    env: Env,
    originAppId: string,
    query: ListRemotePostsQuery,
): Promise<{ posts: RemotePostView[]; cursor?: string }> {
    const service = servicesFor(env).remotePostService;
    const { rows, cursor } = await service.list(
        originAppId,
        {
            ...(query.repo ? { repoDid: query.repo } : {}),
            // Parsed with the service's own rules (a DID authority, an NSID
            // type, a record-key skey); a 400 `REMOTE_URI_UNSUPPORTED` otherwise.
            ...(query.space ? { space: parseRemoteSpaceUri(query.space) } : {}),
            ...(query.kind ? { kind: query.kind } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
    );
    const posts = await service.hydrate(originAppId, rows);
    return { posts, ...(cursor ? { cursor } : {}) };
}

/** The tenant's registered posts among `uris`, hydrated, in request order. */
export async function getRemotePosts(env: Env, originAppId: string, uris: string[]): Promise<{ posts: RemotePostView[] }> {
    const service = servicesFor(env).remotePostService;
    return { posts: await service.hydrate(originAppId, await service.getMany(originAppId, uris)) };
}

/**
 * (Re)run processing on a registered post and answer the view. A request that
 * enables no stage is a 400 before anything is read: a no-op would hide a
 * caller's mistake.
 */
export async function reprocessRemotePost(
    env: Env,
    originAppId: string,
    uri: string,
    processing: ProcessingRequest,
): Promise<RemotePostView> {
    const resolved = resolveInitialProcessing(originAppId, processing);
    if (!resolved) throw new ServiceError('Request must enable at least one processing stage', 400);

    const service = servicesFor(env).remotePostService;
    const { dispatch } = await service.requestProcessing(originAppId, uri, resolved);
    if (dispatch) await dispatchRemoteProcessing(originAppId, uri, env);
    const [view] = await service.hydrate(originAppId, [await service.get(originAppId, uri)]);
    return view;
}

/** Remove a registration and Antiphony's copy. Idempotent: `deleted` is false if there was none. */
export async function unregisterRemotePost(env: Env, originAppId: string, uri: string): Promise<DeleteRemotePostResult> {
    const deleted = await servicesFor(env).remotePostService.delete(originAppId, uri);
    return { uri, deleted };
}

/**
 * Recheck the tenant's records in one space on a fresh delegation, and
 * dispatch processing for each edit the recheck took.
 */
export async function recheckRemoteSpace(
    env: Env,
    originAppId: string,
    body: RecheckRemoteSpaceRequest,
): Promise<RecheckRemoteSpaceResult> {
    const { toDispatch, ...result } = await servicesFor(env).remotePostService.recheckSpace(originAppId, body.space, {
        delegationToken: body.delegationToken,
        ...(body.clientAttestation ? { clientAttestation: body.clientAttestation } : {}),
    });
    for (const job of toDispatch) await dispatchRemoteProcessing(job.originAppId, job.uri, env);
    return result;
}
