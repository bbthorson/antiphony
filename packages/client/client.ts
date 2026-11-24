import { XRPC_NSID } from '@antiphony/shared/nsid';
import type { AudioPostView, PostListView } from '@antiphony/shared/types/audio';
import type {
    DeletePostRequest,
    DeletePostResult,
    EraseAuthorResult,
} from '@antiphony/shared/types/deletion';
import type {
    DeleteRemotePostResult,
    RecheckRemoteSpaceRequest,
    RecheckRemoteSpaceResult,
    RegisterRemotePostRequest,
    RemotePostListView,
    RemotePostsView,
    RemotePostView,
    RemoteThreadPage,
    ReprocessRemotePostRequest,
    UnregisterRemotePostRequest,
} from '@antiphony/shared/types/remote-posts';
import type { TenantStats } from '@antiphony/shared/types/stats';
import type {
    CreateAudioPostRequest,
    DescribeServerResult,
    EraseAuthorXrpcRequest,
    PatchAudioPostRequest,
    UploadAudioResult,
} from '@antiphony/shared/api-codecs';
import { SERVICE_AUTH_HEADER, type ServiceAuthSigner } from './service-auth';

/**
 * Typed, framework-free XRPC client for Antiphony (`specs/xrpc-surface.md`
 * Phase C). Speaks all 19 `/xrpc/*` methods over standard `fetch`, carrying
 * the service token, acting-actor headers, `Idempotency-Key`, and optional
 * `X-Antiphony-Service-Auth` signatures.
 */

export class AntiphonyClientError extends Error {
    readonly status: number;
    readonly code: string;
    readonly requestId: string | null;

    constructor(status: number, code: string, message: string, requestId: string | null = null) {
        super(message);
        this.name = 'AntiphonyClientError';
        this.status = status;
        this.code = code;
        this.requestId = requestId;
    }
}

export interface AntiphonyClientConfig {
    /** Base URL of the Antiphony API (e.g. `https://api.antiphony.dev`). */
    baseUrl: string;
    /** Tenant service token (`Authorization: Bearer <token>`). Omit for public-only reads. */
    serviceToken?: string;
    /** Default acting actor id (`X-Antiphony-Acting-Actor`). */
    defaultActor?: string;
    /** Default acting actor DID (`X-Antiphony-Acting-Actor-Did`). */
    defaultActorDid?: string;
    /** Optional ES256 signer for `X-Antiphony-Service-Auth` (`createServiceAuthSigner`). */
    signServiceAuth?: ServiceAuthSigner;
    /** Custom `fetch` implementation (defaults to global `fetch`). */
    fetch?: typeof fetch;
}

export interface CallOptions {
    /** Acting actor id for this call (overrides `defaultActor`). */
    actor?: string;
    /** Acting actor DID for this call (overrides `defaultActorDid`). */
    actorDid?: string;
    /** `Idempotency-Key` header (`createPost`, `uploadAudio`). */
    idempotencyKey?: string;
    /** Optional `X-Request-ID` for cross-service log correlation. */
    requestId?: string;
    /** AbortSignal forwarded to `fetch`. */
    signal?: AbortSignal;
}

export interface GetThreadParams {
    id: string;
    limit?: number;
    cursor?: string;
}

export interface ThreadPage {
    parent: AudioPostView;
    replies: AudioPostView[];
    cursor: string | null;
}

export interface ListPostsParams {
    limit?: number;
    cursor?: string;
    kind?: 'prompt' | 'reply';
    rootAuthor?: string;
}

export interface CreatePostResult {
    uri: string;
    cid: string;
}

export interface ReprocessPostInput extends PatchAudioPostRequest {
    id: string;
}

export interface UploadAudioInput {
    bytes: Uint8Array | ArrayBuffer;
    contentType: string;
    spaceType?: string;
    skey?: string;
    spaceAuthority?: string;
    remoteSpace?: string;
}

export interface ListRemotePostsParams {
    repo?: string;
    space?: string;
    kind?: 'prompt' | 'reply';
    limit?: number;
    cursor?: string;
}

export interface GetRemoteThreadParams {
    root: string;
    limit?: number;
    cursor?: string;
}

export interface AntiphonyClient {
    // Hosted audio queries
    getPost(id: string, opts?: CallOptions): Promise<AudioPostView>;
    getThread(params: GetThreadParams, opts?: CallOptions): Promise<ThreadPage>;
    listPosts(params?: ListPostsParams, opts?: CallOptions): Promise<PostListView>;
    getPlaybackUrl(cid: string, opts?: CallOptions): Promise<{ url: string }>;

    // Hosted audio procedures
    createPost(input: CreateAudioPostRequest, opts?: CallOptions): Promise<CreatePostResult>;
    reprocessPost(input: ReprocessPostInput, opts?: CallOptions): Promise<AudioPostView>;
    uploadAudio(input: UploadAudioInput, opts?: CallOptions): Promise<UploadAudioResult>;
    deletePost(input: DeletePostRequest, opts?: CallOptions): Promise<DeletePostResult>;
    eraseAuthor(input: EraseAuthorXrpcRequest, opts?: CallOptions): Promise<EraseAuthorResult>;

    // Remote posts
    registerPost(input: RegisterRemotePostRequest, opts?: CallOptions): Promise<RemotePostView>;
    getRemotePost(uri: string, opts?: CallOptions): Promise<RemotePostView>;
    getRemotePosts(uris: string[], opts?: CallOptions): Promise<RemotePostsView>;
    getRemoteThread(params: GetRemoteThreadParams, opts?: CallOptions): Promise<RemoteThreadPage>;
    listRemotePosts(params?: ListRemotePostsParams, opts?: CallOptions): Promise<RemotePostListView>;
    reprocessRemotePost(input: ReprocessRemotePostRequest, opts?: CallOptions): Promise<RemotePostView>;
    unregisterPost(input: UnregisterRemotePostRequest, opts?: CallOptions): Promise<DeleteRemotePostResult>;
    recheckRemoteSpace(input: RecheckRemoteSpaceRequest, opts?: CallOptions): Promise<RecheckRemoteSpaceResult>;

    // Tenancy & server
    getStats(opts?: CallOptions): Promise<TenantStats>;
    describeServer(opts?: CallOptions): Promise<DescribeServerResult>;
}

function buildUrl(
    baseUrl: string,
    nsid: string,
    params?: Record<string, string | number | string[] | undefined>,
): string {
    const root = baseUrl.replace(/\/+$/, '');
    const url = new URL(`${root}/xrpc/${nsid}`);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                for (const item of value) url.searchParams.append(key, item);
            } else {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url.toString();
}

export function createAntiphonyClient(config: AntiphonyClientConfig): AntiphonyClient {
    const fetchImpl = config.fetch ?? fetch;

    async function headersFor(
        nsid: string,
        opts?: CallOptions,
        extra?: Record<string, string>,
    ): Promise<Record<string, string>> {
        const headers: Record<string, string> = { ...extra };
        if (config.serviceToken) {
            headers['authorization'] = `Bearer ${config.serviceToken}`;
        }
        const actor = opts?.actor ?? config.defaultActor;
        const actorDid = opts?.actorDid ?? config.defaultActorDid;
        if (actor) {
            headers['x-antiphony-acting-actor'] = actor;
            if (actorDid) headers['x-antiphony-acting-actor-did'] = actorDid;
        }
        if (opts?.idempotencyKey) {
            headers['idempotency-key'] = opts.idempotencyKey;
        }
        if (opts?.requestId) {
            headers['x-request-id'] = opts.requestId;
        }
        if (config.signServiceAuth) {
            headers[SERVICE_AUTH_HEADER] = await config.signServiceAuth({ kind: 'xrpc', lxm: nsid });
        }
        return headers;
    }

    async function parseResponse<T>(res: Response): Promise<T> {
        const requestId = res.headers.get('x-request-id');
        if (res.ok) {
            return (await res.json()) as T;
        }
        let code = 'UnknownError';
        let message = `HTTP ${res.status}`;
        try {
            const body = (await res.json()) as { error?: unknown; message?: unknown };
            if (typeof body.error === 'string') code = body.error;
            if (typeof body.message === 'string') message = body.message;
        } catch {
            // Non-JSON error body; keep status fallback.
        }
        throw new AntiphonyClientError(res.status, code, message, requestId);
    }

    async function query<T>(
        nsid: string,
        params?: Record<string, string | number | string[] | undefined>,
        opts?: CallOptions,
    ): Promise<T> {
        const res = await fetchImpl(buildUrl(config.baseUrl, nsid, params), {
            method: 'GET',
            headers: await headersFor(nsid, opts),
            signal: opts?.signal,
        });
        return parseResponse<T>(res);
    }

    async function procedure<T>(nsid: string, body: unknown, opts?: CallOptions): Promise<T> {
        const res = await fetchImpl(buildUrl(config.baseUrl, nsid), {
            method: 'POST',
            headers: await headersFor(nsid, opts, { 'content-type': 'application/json' }),
            body: JSON.stringify(body),
            signal: opts?.signal,
        });
        return parseResponse<T>(res);
    }

    return {
        getPost: (id, opts) => query(XRPC_NSID.GetPost, { id }, opts),
        getThread: (params, opts) =>
            query(XRPC_NSID.GetThread, { id: params.id, limit: params.limit, cursor: params.cursor }, opts),
        listPosts: (params, opts) =>
            query(
                XRPC_NSID.ListPosts,
                {
                    limit: params?.limit,
                    cursor: params?.cursor,
                    kind: params?.kind,
                    rootAuthor: params?.rootAuthor,
                },
                opts,
            ),
        getPlaybackUrl: (cid, opts) => query(XRPC_NSID.GetPlaybackUrl, { cid }, opts),

        createPost: (input, opts) => procedure(XRPC_NSID.CreatePost, input, opts),
        reprocessPost: (input, opts) => procedure(XRPC_NSID.ReprocessPost, input, opts),
        uploadAudio: async (input, opts) => {
            const url = buildUrl(config.baseUrl, XRPC_NSID.UploadAudio, {
                spaceType: input.spaceType,
                skey: input.skey,
                spaceAuthority: input.spaceAuthority,
                remoteSpace: input.remoteSpace,
            });
            const body =
                input.bytes instanceof ArrayBuffer
                    ? input.bytes
                    : input.bytes.buffer.slice(
                          input.bytes.byteOffset,
                          input.bytes.byteOffset + input.bytes.byteLength,
                      );
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: await headersFor(XRPC_NSID.UploadAudio, opts, { 'content-type': input.contentType }),
                body: body as ArrayBuffer,
                signal: opts?.signal,
            });
            return parseResponse<UploadAudioResult>(res);
        },
        deletePost: (input, opts) => procedure(XRPC_NSID.DeletePost, input, opts),
        eraseAuthor: (input, opts) => procedure(XRPC_NSID.EraseAuthor, input, opts),

        registerPost: (input, opts) => procedure(XRPC_NSID.RegisterPost, input, opts),
        getRemotePost: (uri, opts) => query(XRPC_NSID.GetRemotePost, { uri }, opts),
        getRemotePosts: (uris, opts) => query(XRPC_NSID.GetRemotePosts, { uris }, opts),
        getRemoteThread: (params, opts) =>
            query(XRPC_NSID.GetRemoteThread, { root: params.root, limit: params.limit, cursor: params.cursor }, opts),
        listRemotePosts: (params, opts) =>
            query(
                XRPC_NSID.ListRemotePosts,
                {
                    repo: params?.repo,
                    space: params?.space,
                    kind: params?.kind,
                    limit: params?.limit,
                    cursor: params?.cursor,
                },
                opts,
            ),
        reprocessRemotePost: (input, opts) => procedure(XRPC_NSID.ReprocessRemotePost, input, opts),
        unregisterPost: (input, opts) => procedure(XRPC_NSID.UnregisterPost, input, opts),
        recheckRemoteSpace: (input, opts) => procedure(XRPC_NSID.RecheckRemoteSpace, input, opts),

        getStats: (opts) => query(XRPC_NSID.GetStats, undefined, opts),
        describeServer: (opts) => query(XRPC_NSID.DescribeServer, undefined, opts),
    };
}
