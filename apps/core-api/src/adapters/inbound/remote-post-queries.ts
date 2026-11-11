import { z } from 'zod';
import { DidStringSchema } from 'shared/types/dids';
import { MAX_REMOTE_POSTS_BATCH, RemotePostUriSchema, RemoteSpaceUriSchema, type RemotePostView } from 'shared/types/remote-posts';
import { parseRemoteSpaceUri } from '@antiphony/core/services/remote-posts';
import { servicesFor } from '../../composition.js';

/**
 * The remote-post reads that list: `dev.antiphony.audio.listRemotePosts` and
 * `dev.antiphony.audio.getRemotePosts`. Lexicon-first: the lexicons under
 * `lexicons/dev/antiphony/audio/` are the contract, the schemas below are what
 * the handlers parse a query string with, and the XRPC and REST adapters both
 * call the two functions here, so the surfaces can't answer differently.
 *
 * The shapes follow atproto's own lists (`com.atproto.repo.listRecords`,
 * `app.bsky.feed.getPosts`): `limit` and `cursor` in, a named array and
 * `cursor` out, and a batch read that leaves out what it doesn't find.
 */

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
