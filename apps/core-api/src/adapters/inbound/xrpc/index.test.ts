import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Route tests for the XRPC surface at `/xrpc/*`.
 *
 * The domain service is mocked — what these cover is the adapter's job: the
 * error dialect, the auth/tenancy gating it shares with REST, and the
 * translation between method NSIDs and domain calls.
 *
 * The load-bearing group is "error dialect": the whole point of the middleware
 * refactor behind this surface is that one auth failure renders two ways
 * depending on which adapter it happened under. Those tests assert both sides
 * of that, including that REST did not change.
 */

// Handlers resolve services through the composition root rather than importing
// a module-scoped singleton — a Worker gets its bindings on `env`, so
// module-load construction is not available there.
const audioPostService = {
    createPost: vi.fn(),
    getPostView: vi.fn(),
    getReplies: vi.fn(),
    setProcessing: vi.fn(),
};

/**
 * An in-memory `IdempotencyStore` with the port's real semantics (atomic claim,
 * settle replays, release deletes), so the createPost suites below exercise the
 * real `lib/idempotency.ts` id derivation rather than a mock of it. `ids` lists
 * every id claimed, in order.
 */
const idempotencyRecords = new Map<string, { status: 'processing' | 'done'; response?: unknown }>();
const idempotencyStore = {
    claim: vi.fn(async (id: string) => {
        const found = idempotencyRecords.get(id);
        if (!found) {
            idempotencyRecords.set(id, { status: 'processing' });
            return 'claimed' as const;
        }
        return found.status === 'done' ? { replay: found.response } : ('in-progress' as const);
    }),
    settle: vi.fn(async (id: string, response: unknown) => {
        idempotencyRecords.set(id, { status: 'done', response });
    }),
    release: vi.fn(async (id: string) => {
        if (idempotencyRecords.get(id)?.status === 'processing') idempotencyRecords.delete(id);
    }),
};

const getBlobSpace = vi.fn();
/** What the rate-limit store answers. `under` except in the over-limit case. */
let rateLimitVerdict: 'under' | 'over' = 'under';

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        audioPostService,
        idempotencyStore,
        audioPostDeps: { getBlobSpace },
    // The rate-limit middleware resolves its store from here. Under limit except
    // in "over the rate limit" below: these suites assert route behaviour, not
    // rate-limit policy (that is middleware/rate-limit-policy.test.ts).
    rateLimitStore: { hit: async () => rateLimitVerdict },
    }),
}));

// `getAppDid` reads the boot-time validated-pin snapshot and throws without it.
// The uri it feeds is a fixed string here; `app-did.test.ts` covers resolution.
vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:test-app.example',
    // Both auth middlewares now await this — the Workers replacement for the
    // boot gate. Its own behaviour is `app-did.test.ts`'s subject; here it just
    // has to not refuse, or every gated XRPC method below answers 503.
    ensureTenantPin: async () => undefined,
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;
// Needed by `audioPlaybackUrl`; without it the helper returns null by design.
process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.test';

const { app } = await import('../../../app.js');

const VIEW = {
    uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/p1',
    cid: 'bafypost1',
    kind: 'prompt' as const,
    authorId: 'u1',
    record: { text: 'hi', createdAt: new Date('2026-06-26T00:00:00Z') },
    viewer: { isAuthor: true, canReply: true },
};

const REPLY = {
    ...VIEW,
    uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/r1',
    cid: 'bafyreply1',
    kind: 'reply' as const,
};

function asView(v: unknown) {
    return v as Awaited<ReturnType<typeof audioPostService.getPostView>>;
}

/** Authenticated as an app, asserting an acting end user. */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        Authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-antiphony-acting-actor': 'u1',
        ...extra,
    };
}

/** Authenticated as an app with no acting actor — a viewer-less read. */
function anonHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${SERVICE_TOKEN}` };
}

beforeEach(() => {
    vi.clearAllMocks();
    idempotencyRecords.clear();
});

// ---------------------------------------------------------------------------

describe('error dialect', () => {
    it('renders an auth failure as XRPC { error, message }, not the REST envelope', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.getPost?id=p1');

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body).toEqual({
            error: 'AuthenticationRequired',
            message: 'Authentication required',
        });
        // The distinction that matters to a client: `error` is a string here
        // and an object under REST. Parsing one as the other silently fails.
        expect(typeof body.error).toBe('string');
        expect(body.success).toBeUndefined();
    });

    it('leaves the REST envelope unchanged for the same failure', async () => {
        const res = await app().request('/api/v1/posts/p1');

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Authentication required');
        expect(body.requestId).toBeTruthy();
        // Not the XRPC shape.
        expect(typeof body.error).toBe('object');
    });

    it('renders a missing acting actor on a procedure as AuthenticationRequired', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi' }),
        });

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
            error: 'AuthenticationRequired',
            message: 'X-Antiphony-Acting-Actor header required for this endpoint',
        });
    });

    it('maps a domain 403 to Forbidden', async () => {
        const { ForbiddenError } = await import('shared/errors');
        vi.mocked(audioPostService.setProcessing).mockRejectedValueOnce(
            new ForbiddenError('Not the post author'),
        );

        const res = await app().request('/xrpc/dev.antiphony.audio.reprocessPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ id: 'p1', processing: { transcribe: true } }),
        });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden', message: 'Not the post author' });
    });

    it('maps an unknown throw to InternalServerError without leaking internals', async () => {
        vi.mocked(audioPostService.getPostView).mockRejectedValueOnce(
            new Error('database exploded: connection string postgres://user:pw@host'),
        );

        const res = await app().request('/xrpc/dev.antiphony.audio.getPost?id=p1', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('InternalServerError');
        expect(body.message).toBe('An unexpected error occurred');
        expect(JSON.stringify(body)).not.toContain('postgres://');
    });

    it('renders a malformed JSON body as InvalidRequest', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: '{not json',
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('InvalidRequest');
    });
});

// ---------------------------------------------------------------------------

describe('over the rate limit', () => {
    afterEach(() => {
        rateLimitVerdict = 'under';
    });

    it('refuses a procedure as RateLimitExceeded with a 429, and never reaches the service', async () => {
        rateLimitVerdict = 'over';
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'hi' }),
        });

        expect(res.status).toBe(429);
        expect(await res.json()).toMatchObject({ error: 'RateLimitExceeded' });
        expect(audioPostService.createPost).not.toHaveBeenCalled();
    });
});

describe('dev.antiphony.audio.getPost', () => {
    it('returns the hydrated view for an anonymous (viewer-less) read', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));

        const res = await app().request('/xrpc/dev.antiphony.audio.getPost?id=p1', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).uri).toBe(VIEW.uri);
        // Tenancy comes from the credential; the viewer is null with no actor.
        expect(audioPostService.getPostView).toHaveBeenCalledWith('test-app', 'p1', null);
    });

    it('passes the acting actor through as the viewer', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));

        await app().request('/xrpc/dev.antiphony.audio.getPost?id=p1', { headers: authHeaders() });

        expect(audioPostService.getPostView).toHaveBeenCalledWith('test-app', 'p1', 'u1');
    });

    it('404s as RecordNotFound when the post is absent or cross-tenant', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(null));

        const res = await app().request('/xrpc/dev.antiphony.audio.getPost?id=nope', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('RecordNotFound');
    });

    it('400s as InvalidRequest when `id` is missing, naming the parameter', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.getPost', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('InvalidRequest');
        expect(body.message).toContain('id');
    });
});

// ---------------------------------------------------------------------------

describe('dev.antiphony.audio.getThread', () => {
    it('returns the parent plus its replies', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));
        vi.mocked(audioPostService.getReplies).mockResolvedValueOnce([asView(REPLY)!]);

        const res = await app().request('/xrpc/dev.antiphony.audio.getThread?id=p1', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.parent.uri).toBe(VIEW.uri);
        expect(body.replies).toHaveLength(1);
        // The thread query keys on the parent's uri, not its id.
        expect(audioPostService.getReplies).toHaveBeenCalledWith('test-app', VIEW.uri, null, {
            limit: 50,
            cursorId: undefined,
        });
    });

    it('returns a null cursor on a short page', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));
        vi.mocked(audioPostService.getReplies).mockResolvedValueOnce([asView(REPLY)!]);

        const res = await app().request('/xrpc/dev.antiphony.audio.getThread?id=p1&limit=50', {
            headers: anonHeaders(),
        });

        expect((await res.json()).cursor).toBeNull();
    });

    it('returns the last rkey as the cursor on a full page', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));
        vi.mocked(audioPostService.getReplies).mockResolvedValueOnce([asView(REPLY)!]);

        const res = await app().request('/xrpc/dev.antiphony.audio.getThread?id=p1&limit=1', {
            headers: anonHeaders(),
        });

        expect((await res.json()).cursor).toBe('r1');
    });

    it('404s when the parent is absent, rather than returning an empty thread', async () => {
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(null));

        const res = await app().request('/xrpc/dev.antiphony.audio.getThread?id=nope', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(404);
        expect(audioPostService.getReplies).not.toHaveBeenCalled();
    });

    it('400s on an out-of-range limit', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.getThread?id=p1&limit=500', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('InvalidRequest');
    });
});

// ---------------------------------------------------------------------------

describe('dev.antiphony.audio.getPlaybackUrl', () => {
    it('resolves a cid to a playback url scoped to the caller tenancy', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.getPlaybackUrl?cid=bafyaudio', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(200);
        const { url } = await res.json();
        // The blob path is built from the credential's tenancy, never a param.
        expect(url).toContain(encodeURIComponent('blobs/test-app/bafyaudio'));
    });

    it('404s when the cid cannot form a safe object path', async () => {
        const res = await app().request(
            `/xrpc/dev.antiphony.audio.getPlaybackUrl?cid=${encodeURIComponent('../../etc/passwd')}`,
            { headers: anonHeaders() },
        );

        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('RecordNotFound');
    });

    it('400s when `cid` is missing', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.getPlaybackUrl', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(400);
    });

    it('signs the url for audio stored in a space', async () => {
        process.env.ANTIPHONY_PLAYBACK_SECRET = 'test-playback-secret-0123456789abcdef';
        getBlobSpace.mockResolvedValueOnce({ space: { type: 'game.bardcast.space.campaign', skey: 'thornwood' } });
        try {
            const res = await app().request('/xrpc/dev.antiphony.audio.getPlaybackUrl?cid=bafyaudio', {
                headers: anonHeaders(),
            });

            expect(res.status).toBe(200);
            const { url } = await res.json();
            expect(url).toMatch(/&exp=\d+&sig=[A-Za-z0-9_-]+$/);
        } finally {
            delete process.env.ANTIPHONY_PLAYBACK_SECRET;
        }
    });

    it('refuses private audio rather than handing out an unsigned url, when it cannot sign', async () => {
        getBlobSpace.mockResolvedValueOnce({ space: { type: 'game.bardcast.space.campaign', skey: 'thornwood' } });

        const res = await app().request('/xrpc/dev.antiphony.audio.getPlaybackUrl?cid=bafyaudio', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('RecordNotFound');
    });
});

// ---------------------------------------------------------------------------

describe('dev.antiphony.audio.createPost', () => {
    it('creates the post and answers with a StrongRef', async () => {
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({
            id: 'p1',
            cid: 'bafypost1',
        } as Awaited<ReturnType<typeof audioPostService.createPost>>);

        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'hello' }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/p1',
            cid: 'bafypost1',
        });
    });

    it('stamps tenancy and author server-side, ignoring any client-supplied values', async () => {
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({
            id: 'p1',
            cid: 'bafypost1',
        } as Awaited<ReturnType<typeof audioPostService.createPost>>);

        await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'hello', originAppId: 'other-tenant', authorId: 'someone-else' }),
        });

        expect(audioPostService.createPost).toHaveBeenCalledWith(
            expect.objectContaining({ originAppId: 'test-app', authorId: 'u1' }),
        );
    });

    it('400s as InvalidRequest on a payload that fails the schema', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 42 }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('InvalidRequest');
        expect(audioPostService.createPost).not.toHaveBeenCalled();
    });

    const REF = { uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/root', cid: 'bafyroot' };

    it('passes a space named on a reply through to the service', async () => {
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({
            id: 'r1',
            cid: 'bafyreply1',
            space: { type: 'audio.voxpop.space.replies', skey: 'root', authorSegment: 'did:web:test-app.example' },
        } as Awaited<ReturnType<typeof audioPostService.createPost>>);

        const space = { type: 'audio.voxpop.space.replies', skey: 'root' };
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'an answer', reply: { root: REF, parent: REF }, space }),
        });

        expect(res.status).toBe(200);
        expect(audioPostService.createPost).toHaveBeenCalledWith(expect.objectContaining({ space }));
        // The author segment is the authority's DID (atproto-authority-model.md D8).
        expect((await res.json()).uri).toBe(
            'at://did:web:test-app.example/space/audio.voxpop.space.replies/root/did:web:test-app.example/dev.antiphony.audio.post/r1',
        );
    });

    it("passes spaceAuthor and the acting actor's DID through, and answers with the member's segment", async () => {
        const PLAYER = 'did:plc:abc123player';
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({
            id: 'r2',
            cid: 'bafyreply2',
            space: { type: 'game.bardcast.space.campaign', skey: 'thornwood', authorSegment: PLAYER },
        } as Awaited<ReturnType<typeof audioPostService.createPost>>);

        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', 'x-antiphony-acting-actor-did': PLAYER }),
            body: JSON.stringify({ text: 'my answer', space: { type: 'game.bardcast.space.campaign', skey: 'thornwood' }, spaceAuthor: 'actor' }),
        });

        expect(res.status).toBe(200);
        expect(audioPostService.createPost).toHaveBeenCalledWith(expect.objectContaining({ spaceAuthor: 'actor', authorDid: PLAYER }));
        expect((await res.json()).uri).toBe(
            `at://did:web:test-app.example/space/game.bardcast.space.campaign/thornwood/${PLAYER}/dev.antiphony.audio.post/r2`,
        );
    });

    it("passes a named authority through, and answers with the post's own authority in its uri", async () => {
        const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({
            id: 'p3',
            cid: 'bafyp3',
            originAppId: 'test-app',
            authority: TABLE,
        } as Awaited<ReturnType<typeof audioPostService.createPost>>);
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'an org prompt', authority: TABLE }),
        });
        expect(res.status).toBe(200);
        expect(audioPostService.createPost).toHaveBeenCalledWith(expect.objectContaining({ authority: TABLE }));
        expect((await res.json()).uri).toBe(`at://${TABLE}/dev.antiphony.audio.post/p3`);
    });

    it('refuses an unknown spaceAuthor', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'hi', spaceAuthor: 'someone-else' }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('InvalidRequest');
    });

    it('answers a reply whose StrongRef CID is stale with the named error ReplyCidMismatch', async () => {
        const { ServiceError } = await import('shared/errors');
        vi.mocked(audioPostService.createPost).mockRejectedValueOnce(
            new ServiceError("reply.parent.cid doesn't match the parent post's CID", 400, undefined, 'REPLY_CID_MISMATCH'),
        );

        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ text: 'x', reply: { root: REF, parent: { ...REF, cid: 'bafyplaceholder' } } }),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'ReplyCidMismatch',
            message: "reply.parent.cid doesn't match the parent post's CID",
        });
    });
});

// ---------------------------------------------------------------------------

describe('dev.antiphony.audio.createPost — Idempotency-Key', () => {
    const KEY = { 'idempotency-key': 'retry-me' };

    function create(body: unknown = { text: 'hello' }, headers: Record<string, string> = KEY) {
        return app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', ...headers }),
            body: JSON.stringify(body),
        });
    }

    function created(id: string, cid: string) {
        vi.mocked(audioPostService.createPost).mockResolvedValueOnce({ id, cid } as Awaited<
            ReturnType<typeof audioPostService.createPost>
        >);
    }

    it('replays the first response for a retry and creates one post', async () => {
        created('p1', 'bafypost1');

        const first = await create();
        const second = await create();

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual(await first.clone().json());
        expect(await first.json()).toEqual({
            uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/p1',
            cid: 'bafypost1',
        });
        expect(audioPostService.createPost).toHaveBeenCalledTimes(1);
    });

    it('answers a duplicate that arrives while the first is in flight with 409 Conflict', async () => {
        let finish!: () => void;
        vi.mocked(audioPostService.createPost).mockImplementationOnce(
            () => new Promise((resolve) => { finish = () => resolve({ id: 'p1', cid: 'bafypost1' }); }),
        );

        const inFlight = create();
        await vi.waitFor(() => expect(audioPostService.createPost).toHaveBeenCalled());
        const duplicate = await create();

        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toEqual({
            error: 'Conflict',
            message: 'An earlier request with the same idempotency key is still in flight',
        });
        finish();
        expect((await inFlight).status).toBe(200);
        expect(audioPostService.createPost).toHaveBeenCalledTimes(1);
    });

    it('releases the claim after a validation failure, so a corrected retry creates the post', async () => {
        const bad = await create({ text: 'hi', spaceAuthor: 'someone-else' });
        expect(bad.status).toBe(400);
        expect(idempotencyStore.release).toHaveBeenCalledTimes(1);
        expect(idempotencyStore.settle).not.toHaveBeenCalled();

        created('p1', 'bafypost1');
        const retry = await create({ text: 'hi' });
        expect(retry.status).toBe(200);
        expect(audioPostService.createPost).toHaveBeenCalledTimes(1);
    });

    it('releases the claim after a malformed body', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', ...KEY }),
            body: '{not json',
        });
        expect(res.status).toBe(400);
        expect(idempotencyStore.release).toHaveBeenCalledTimes(1);
        expect(idempotencyRecords.size).toBe(0);
    });

    it('releases the claim after a thrown service error, so a retry is not locked out', async () => {
        const { ServiceError } = await import('shared/errors');
        vi.mocked(audioPostService.createPost).mockRejectedValueOnce(new ServiceError('nope', 400));

        const failed = await create();
        expect(failed.status).toBe(400);
        expect(idempotencyStore.release).toHaveBeenCalledTimes(1);
        expect(idempotencyStore.settle).not.toHaveBeenCalled();

        created('p1', 'bafypost1');
        expect((await create()).status).toBe(200);
    });

    it('does not release the claim after a successful create', async () => {
        created('p1', 'bafypost1');
        await create();
        expect(idempotencyStore.release).not.toHaveBeenCalled();
        expect(idempotencyStore.settle).toHaveBeenCalledTimes(1);
    });

    it('behaves as before without the header: no store use, a second post per request', async () => {
        created('p1', 'bafypost1');
        created('p2', 'bafypost2');

        await create({ text: 'hello' }, {});
        const second = await create({ text: 'hello' }, {});

        expect((await second.json()).cid).toBe('bafypost2');
        expect(audioPostService.createPost).toHaveBeenCalledTimes(2);
        expect(idempotencyStore.claim).not.toHaveBeenCalled();
        expect(idempotencyStore.settle).not.toHaveBeenCalled();
    });

    it('keeps one actor\'s key from another actor\'s retry', async () => {
        created('p1', 'bafypost1');
        created('p2', 'bafypost2');

        await create();
        const other = await app().request('/xrpc/dev.antiphony.audio.createPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', 'x-antiphony-acting-actor': 'u2', ...KEY }),
            body: JSON.stringify({ text: 'hello' }),
        });

        expect((await other.json()).cid).toBe('bafypost2');
        expect(audioPostService.createPost).toHaveBeenCalledTimes(2);
    });

    it('never replays one surface\'s response on the other for the same actor and key', async () => {
        created('p1', 'bafypost1');
        created('p2', 'bafypost2');

        const viaRest = await app().request('/api/v1/posts', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', ...KEY }),
            body: JSON.stringify({ text: 'hello' }),
        });
        const viaXrpc = await create();

        expect(await viaRest.json()).toEqual({ success: true, data: { postId: 'p1' } });
        expect(await viaXrpc.json()).toEqual({
            uri: 'at://did:web:test-app.example/dev.antiphony.audio.post/p2',
            cid: 'bafypost2',
        });
        // Two claims under two different ids, and a retry on each surface still
        // replays its own body.
        expect(new Set(idempotencyRecords.keys()).size).toBe(2);
        const restRetry = await app().request('/api/v1/posts', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json', ...KEY }),
            body: JSON.stringify({ text: 'hello' }),
        });
        expect(await restRetry.json()).toEqual({ success: true, data: { postId: 'p1' } });
        expect((await (await create()).json()).cid).toBe('bafypost2');
        expect(audioPostService.createPost).toHaveBeenCalledTimes(2);
    });
});

describe('dev.antiphony.audio.createPost — declared errors', () => {
    /**
     * Every refusal the domain can give a create, rendered by this adapter,
     * must be an error the lexicon declares (or one every XRPC method may
     * answer). A client generated from the lexicon has no case for anything
     * else. A reply by a non-participant answered `Forbidden` for a while with
     * no such error declared.
     */
    const ANY_METHOD = new Set(['AuthenticationRequired', 'RateLimitExceeded', 'InternalServerError']);

    it('answers only errors the lexicon declares', async () => {
        const { readFileSync } = await import('node:fs');
        const { ForbiddenError, NotFoundError, ValidationError, ServiceError } = await import('shared/errors');
        const { REPLY_CID_MISMATCH } = await import('@antiphony/core/services/audio-posts');
        const lexicon = JSON.parse(
            readFileSync(new URL('../../../../../../lexicons/dev/antiphony/audio/createPost.json', import.meta.url), 'utf8'),
        ) as { defs: { main: { errors: { name: string }[] } } };
        const declared = new Set(lexicon.defs.main.errors.map((e) => e.name));

        const refusals = [
            new ValidationError("reply.root must name the thread's root post"),
            new NotFoundError('Parent post not found'),
            new ForbiddenError('Only the thread participants can reply here'),
            new ServiceError("reply.parent.cid doesn't match", 400, undefined, REPLY_CID_MISMATCH),
            new ServiceError('Idempotency conflict', 409),
        ];
        const undeclared: string[] = [];
        for (const err of refusals) {
            vi.mocked(audioPostService.createPost).mockRejectedValueOnce(err);
            const res = await app().request('/xrpc/dev.antiphony.audio.createPost', {
                method: 'POST',
                headers: authHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify({ text: 'x' }),
            });
            const { error } = (await res.json()) as { error: string };
            if (!declared.has(error) && !ANY_METHOD.has(error)) undeclared.push(`${err.status} → ${error}`);
        }
        expect(undeclared).toEqual([]);
    });
});

describe('dev.antiphony.audio.reprocessPost', () => {
    it('sets processing and returns the re-hydrated view', async () => {
        vi.mocked(audioPostService.setProcessing).mockResolvedValueOnce(
            {} as Awaited<ReturnType<typeof audioPostService.setProcessing>>,
        );
        vi.mocked(audioPostService.getPostView).mockResolvedValueOnce(asView(VIEW));

        const res = await app().request('/xrpc/dev.antiphony.audio.reprocessPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ id: 'p1', processing: { transcribe: true } }),
        });

        expect(res.status).toBe(200);
        expect((await res.json()).uri).toBe(VIEW.uri);
        expect(audioPostService.setProcessing).toHaveBeenCalledWith(
            'test-app',
            'p1',
            'u1',
            expect.anything(),
        );
    });

    it('400s when the request enables no processing stage', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.reprocessPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ id: 'p1', processing: {} }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).message).toContain('at least one processing stage');
        expect(audioPostService.setProcessing).not.toHaveBeenCalled();
    });

    it('400s when `id` is absent from the body', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.reprocessPost', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ processing: { transcribe: true } }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('InvalidRequest');
    });
});

// ---------------------------------------------------------------------------

describe('surface wiring', () => {
    it('does not appear in the OpenAPI document — XRPC is a separate contract', async () => {
        const res = await app().request('/openapi.json');
        const doc = await res.json();

        expect(Object.keys(doc.paths).some((p) => p.startsWith('/xrpc'))).toBe(false);
    });

    it('404s an unknown method NSID', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.notAMethod', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(404);
    });
});
