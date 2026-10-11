import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Route tests for `/api/v1/posts` (the Antiphony `dev.antiphony.audio.post`
 * surface). The `audioPostService` is mocked — these cover the HTTP behavior:
 * auth gating, validation, origin-app stamping, the create→get→list flow, the
 * threaded-replies path, and 404 on a missing/cross-tenant post.
 */

// Routes resolve services through the composition root now, rather than
// importing a module-scoped singleton — a Worker gets its bindings on `env`, so
// module-load construction is not available there.
const rateLimitKeys: string[] = [];
/** What the store answers. `under` everywhere except the over-limit cases below. */
let rateLimitVerdict: 'under' | 'over' = 'under';

const audioPostService = {
    createPost: vi.fn(),
    getPostView: vi.fn(),
    getPostsForAuthor: vi.fn(),
    getRepliesByRootAuthor: vi.fn(),
    getReplies: vi.fn(),
    setProcessing: vi.fn(),
};

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        audioPostService,
    // The rate-limit middleware resolves its store from here. Under limit on every hit:
    // these suites assert route behaviour, not rate-limit policy (that is
    // middleware/rate-limit.test.ts).
    //
    // The keys ARE recorded, though. Which bucket a write lands in is route
    // wiring — a `keyBy` this file's routes either pass or do not — and the
    // 2026-08-21 incident was entirely a wrong key with a 200-shaped cause:
    // every user of a connecting app sharing one write allowance because the
    // limit was keyed by the app's address. `middleware/rate-limit-keying.test.ts`
    // pins what the middleware does with a key; this pins that these routes ask
    // for the right one.
    rateLimitStore: {
        hit: async (key: string) => {
            rateLimitKeys.push(key);
            return rateLimitVerdict;
        },
    },
    }),
}));

// Every export the route imports must be here: a missing one throws on first
// use, and `releaseIdempotencyClaim` is used on every failure path of a create
// — so leaving it out turned each domain error into a 500 in this file, which
// is why no case below could assert one.
vi.mock('../../../lib/idempotency.js', () => ({
    checkIdempotency: vi.fn(async () => null),
    saveIdempotencyResult: vi.fn(async () => undefined),
    releaseIdempotencyClaim: vi.fn(async () => undefined),
    IdempotencyInProgressError: class extends Error {},
}));

// The caller authenticates as the application `test-app` via a service token;
// the acting end user arrives via the X-Antiphony-Acting-Actor header.
const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
// Every gated route now proves its tenant's app-DID custody in the auth
// middleware — the Workers replacement for the boot gate. Seed the snapshot
// so these cases keep testing their own subject rather than a missing pin.
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example' });

const { ForbiddenError, NotFoundError, ServiceError } = await import('shared/errors');
const { REPLY_CID_MISMATCH } = await import('@antiphony/core/services/audio-posts');
const { checkIdempotency, releaseIdempotencyClaim, saveIdempotencyResult } = await import('../../../lib/idempotency.js');

const VIEW = {
    uri: 'at://u1/dev.antiphony.audio.post/p1',
    cid: 'p1',
    kind: 'prompt' as const,
    authorId: 'u1',
    authorDid: 'did:web:voxpop.audio',
    record: { text: 'hi', title: 'Q', createdAt: new Date('2026-06-26T00:00:00Z') },
    embed: { $type: 'dev.antiphony.embed.audio#view' as const, url: 'https://signed.example/a.webm' },
    viewer: { isAuthor: true },
};

function asView(v: unknown) {
    return v as Awaited<ReturnType<typeof audioPostService.getPostView>>;
}

// The acting actor asserted on the next authenticated request. Tests call
// `authAs(uid)` before a request; `authHeaders()` reads it at call time.
let actingActor = 'u1';
function authAs(uid: string) {
    actingActor = uid;
}
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        Authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-antiphony-acting-actor': actingActor,
        ...extra,
    };
}

// A tenancy-scoped read with no acting actor: the service token establishes the
// tenant, viewerUid stays null (anonymous, viewer-less public projection).
const READ_AUTH = { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } };

describe('/api/v1/posts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(checkIdempotency).mockResolvedValue(null);
    });

    describe('POST /', () => {
        it('rejects an unauthenticated create with 401', async () => {
            const res = await app().request('/api/v1/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'hi', embed: undefined }),
            });
            expect(res.status).toBe(401);
            expect(audioPostService.createPost).not.toHaveBeenCalled();
        });

        it('stamps origin app + author server-side and returns the new id', async () => {
            authAs('u1');
            vi.mocked(audioPostService.createPost).mockResolvedValue({ id: 'p1' } as Awaited<ReturnType<typeof audioPostService.createPost>>);

            const res = await app().request('/api/v1/posts', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: 'a question', title: 'Headline' }),
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toEqual({ success: true, data: { postId: 'p1' } });
            expect(audioPostService.createPost).toHaveBeenCalledWith(
                expect.objectContaining({ originAppId: 'test-app', authorId: 'u1', text: 'a question', title: 'Headline' }),
            );
        });

        it('rejects a reply that carries a title (codec refine) with 400', async () => {
            authAs('u1');
            const ref = { uri: 'at://u1/dev.antiphony.audio.post/root', cid: 'root' };
            const res = await app().request('/api/v1/posts', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: '', title: 'nope', reply: { root: ref, parent: ref } }),
            });
            expect(res.status).toBe(400);
            expect(audioPostService.createPost).not.toHaveBeenCalled();
        });

        it('rejects a completely empty post (no text, no embed) with 400', async () => {
            authAs('u1');
            const res = await app().request('/api/v1/posts', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: '   ' }),
            });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /:postId', () => {
        it('returns the hydrated view (service token, anonymous viewer)', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(VIEW));
            const res = await app().request('/api/v1/posts/p1', READ_AUTH);
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.uri).toBe(VIEW.uri);
            expect(body.data.embed.url).toContain('signed');
            // Tenancy comes from the service credential; no acting actor ⇒ null viewer.
            expect(audioPostService.getPostView).toHaveBeenCalledWith('test-app', 'p1', null);
        });

        it('401s without a service token (reads are gated)', async () => {
            const res = await app().request('/api/v1/posts/p1');
            expect(res.status).toBe(401);
            expect(audioPostService.getPostView).not.toHaveBeenCalled();
        });

        it('404s when the post is missing or belongs to another origin app', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(null));
            const res = await app().request('/api/v1/posts/nope', READ_AUTH);
            expect(res.status).toBe(404);
        });
    });

    describe('GET / (list)', () => {
        it('lists the viewer posts and sets nextCursor only on a full page', async () => {
            authAs('u1');
            vi.mocked(audioPostService.getPostsForAuthor).mockResolvedValue([asView(VIEW)!]);
            const res = await app().request('/api/v1/posts?limit=1', { headers: authHeaders() });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.items).toHaveLength(1);
            expect(body.data.nextCursor).toBe('p1'); // full page (1 of 1) → cursor = trailing id
            expect(audioPostService.getPostsForAuthor).toHaveBeenCalledWith(
                'test-app', 'u1', 'u1', expect.objectContaining({ limit: 1 }),
            );
        });

        it('requires auth', async () => {
            const res = await app().request('/api/v1/posts');
            expect(res.status).toBe(401);
        });

        it('with rootAuthor, returns replies addressed to that author (not the viewer\'s own)', async () => {
            authAs('viewer');
            const replyView = { ...VIEW, uri: 'at://x/dev.antiphony.audio.post/r1', kind: 'reply' as const };
            vi.mocked(audioPostService.getRepliesByRootAuthor).mockResolvedValue([asView(replyView)!]);

            const res = await app().request('/api/v1/posts?rootAuthor=creator&limit=1', { headers: authHeaders() });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.items[0].kind).toBe('reply');
            expect(body.data.nextCursor).toBe('r1');
            // Queries the rootAuthorId facet with the explicit author; the viewer
            // (acting actor) is passed through for viewer state, NOT as the author.
            expect(audioPostService.getRepliesByRootAuthor).toHaveBeenCalledWith(
                'test-app', 'creator', 'viewer', expect.objectContaining({ limit: 1 }),
            );
            // The default viewer-authored query is NOT used in this mode.
            expect(audioPostService.getPostsForAuthor).not.toHaveBeenCalled();
        });
    });

    describe('GET /:postId/replies', () => {
        it('404s when the parent post is missing', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(null));
            const res = await app().request('/api/v1/posts/p1/replies', READ_AUTH);
            expect(res.status).toBe(404);
            expect(audioPostService.getReplies).not.toHaveBeenCalled();
        });

        it('401s without a service token', async () => {
            const res = await app().request('/api/v1/posts/p1/replies');
            expect(res.status).toBe(401);
            expect(audioPostService.getPostView).not.toHaveBeenCalled();
        });

        it('keys the thread query on the parent view uri', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(VIEW));
            vi.mocked(audioPostService.getReplies).mockResolvedValue([]);
            const res = await app().request('/api/v1/posts/p1/replies', READ_AUTH);
            expect(res.status).toBe(200);
            expect(audioPostService.getReplies).toHaveBeenCalledWith('test-app', VIEW.uri, null, expect.objectContaining({ limit: 50 }));
        });
    });

    describe('PATCH /:postId', () => {
        it('401s without an acting actor (requireAuth)', async () => {
            const res = await app().request('/api/v1/posts/p1', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ processing: { transcribe: true } }),
            });
            expect(res.status).toBe(401);
            expect(audioPostService.setProcessing).not.toHaveBeenCalled();
        });

        it('triggers processing for the author and returns the re-hydrated view', async () => {
            authAs('u1');
            vi.mocked(audioPostService.setProcessing).mockResolvedValue(
                { id: 'p1' } as Awaited<ReturnType<typeof audioPostService.setProcessing>>,
            );
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(VIEW));

            const res = await app().request('/api/v1/posts/p1', {
                method: 'PATCH',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ processing: { transcribe: true } }),
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.uri).toBe(VIEW.uri);
            // Author is the acting actor; the resolved per-stage state is passed through.
            expect(audioPostService.setProcessing).toHaveBeenCalledWith(
                'test-app', 'p1', 'u1', expect.objectContaining({ transcribe: expect.any(String) }),
            );
        });

        it('400s a no-op patch that enables no stage, without calling the service', async () => {
            authAs('u1');
            const res = await app().request('/api/v1/posts/p1', {
                method: 'PATCH',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ processing: { transcribe: false } }),
            });
            expect(res.status).toBe(400);
            expect(audioPostService.setProcessing).not.toHaveBeenCalled();
        });

        it('400s when the body omits processing entirely (schema)', async () => {
            authAs('u1');
            const res = await app().request('/api/v1/posts/p1', {
                method: 'PATCH',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: 'edit me' }),
            });
            expect(res.status).toBe(400);
            expect(audioPostService.setProcessing).not.toHaveBeenCalled();
        });
    });
});

/**
 * Which rate-limit bucket a write lands in.
 *
 * The regression, in one sentence: `POST /posts` was IP-keyed, every write from
 * a connecting app arrives from that app's servers, so one allowance of 10 per
 * 15 minutes covered its entire user base — and on Cloudflare, where the address
 * did not resolve at all, it covered the entire platform. A creator's first
 * prompt of the day returned 429 on a budget spent by other people's reads.
 */
describe('/api/v1/posts — rate-limit bucketing', () => {
    beforeEach(() => {
        rateLimitKeys.length = 0;
        audioPostService.createPost.mockResolvedValue({ postId: 'p1' });
        vi.mocked(checkIdempotency).mockResolvedValue(null);
    });

    const body = {
        text: 'hi',
        title: 'Q',
        embed: { $type: 'dev.antiphony.embed.audio', audio: { $type: 'blob', ref: { $link: 'b1' }, mimeType: 'audio/webm', size: 1 } },
    };

    async function createAs(uid: string) {
        authAs(uid);
        return app().request('/api/v1/posts', {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('keys the write by acting actor, not by the calling app address', async () => {
        await createAs('alice');
        await createAs('bob');

        const writeKeys = rateLimitKeys.filter((k) => k.startsWith('ratelimit_write_'));
        expect(writeKeys).toEqual([
            'ratelimit_write_test-app:alice',
            'ratelimit_write_test-app:bob',
        ]);
    });

    it('still applies an aggregate bound above the actor-keyed limit', async () => {
        await createAs('alice');

        // Actor ids are app-asserted, so the actor-keyed bucket has unbounded
        // cardinality and bounds nothing in aggregate on its own.
        expect(rateLimitKeys.some((k) => k.startsWith('ratelimit_writeAggregate_'))).toBe(true);
    });

    it('does not put a read and a write in the same bucket', async () => {
        await createAs('alice');
        rateLimitKeys.length = 0;
        await app().request('/api/v1/posts/p1', READ_AUTH);

        expect(rateLimitKeys.every((k) => !k.startsWith('ratelimit_write_'))).toBe(true);
    });
});

/**
 * What a create the domain refuses answers on the wire. The service's own
 * decisions are packages/core's subject; this pins that each refusal keeps its
 * status and code through the REST error handler, and that the idempotency
 * claim is released so a corrected retry with the same key is not stuck
 * replaying (or 409ing on) the refusal.
 */
describe('POST /api/v1/posts — domain refusals', () => {
    const IDEMPOTENCY_KEY = { 'idempotency-key': 'retry-me' };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(checkIdempotency).mockResolvedValue(null);
        authAs('u1');
    });

    async function create() {
        return app().request('/api/v1/posts', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json', ...IDEMPOTENCY_KEY }),
            body: JSON.stringify({ text: 'a reply', reply: { root: { uri: 'at://x/c/r', cid: 'r' }, parent: { uri: 'at://x/c/r', cid: 'r' } } }),
        });
    }

    it.each([
        ['a missing or cross-tenant parent', new NotFoundError('Parent post not found'), 404, 'NOT_FOUND'],
        ['a stale StrongRef CID', new ServiceError("reply.parent.cid doesn't match", 400, undefined, REPLY_CID_MISMATCH), 400, REPLY_CID_MISMATCH],
        ['a reply by a non-participant', new ForbiddenError('Only the thread participants can reply here'), 403, 'FORBIDDEN'],
    ])('answers %s with its status and code, and releases the claim', async (_case, err, status, code) => {
        audioPostService.createPost.mockRejectedValue(err);

        const res = await create();

        expect(res.status).toBe(status);
        const body = await res.json();
        expect(body).toMatchObject({ success: false, error: { message: err.message } });
        expect(body.error.code).toBe(code);
        expect(releaseIdempotencyClaim).toHaveBeenCalledTimes(1);
        expect(saveIdempotencyResult).not.toHaveBeenCalled();
    });

    it('does not release the claim after a successful create', async () => {
        audioPostService.createPost.mockResolvedValue({ id: 'p1' });

        expect((await create()).status).toBe(200);
        expect(releaseIdempotencyClaim).not.toHaveBeenCalled();
        expect(saveIdempotencyResult).toHaveBeenCalledTimes(1);
    });
});

/**
 * The refusal itself. Every other case in this file runs under the limit, so
 * without these nothing anywhere asserts that the middleware turns an `over`
 * verdict into a 429 — it could stop enforcing and the suite would stay green.
 */
describe('/api/v1/posts — over the rate limit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rateLimitVerdict = 'over';
    });
    afterEach(() => {
        rateLimitVerdict = 'under';
    });

    it('refuses a write with 429 RATE_LIMITED, and never reaches the service', async () => {
        authAs('u1');
        const res = await app().request('/api/v1/posts', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ text: 'hi' }),
        });

        expect(res.status).toBe(429);
        expect(await res.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
        expect(audioPostService.createPost).not.toHaveBeenCalled();
    });

    it('refuses a read with 429 too', async () => {
        const res = await app().request('/api/v1/posts/p1', READ_AUTH);

        expect(res.status).toBe(429);
        expect(audioPostService.getPostView).not.toHaveBeenCalled();
    });
});
