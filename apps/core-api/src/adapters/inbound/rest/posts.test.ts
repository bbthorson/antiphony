import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route tests for `/api/v1/posts` (the Antiphony `dev.antiphony.audio.post`
 * surface). The `audioPostService` is mocked — these cover the HTTP behavior:
 * auth gating, validation, origin-app stamping, the create→get→list flow, the
 * threaded-replies path, and 404 on a missing/cross-tenant post.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    audioPostService: {
        createPost: vi.fn(),
        getPostView: vi.fn(),
        getPostsForAuthor: vi.fn(),
        getReplies: vi.fn(),
    },
}));

vi.mock('../../../lib/idempotency.js', () => ({
    checkIdempotency: vi.fn(async () => null),
    saveIdempotencyResult: vi.fn(async () => undefined),
    IdempotencyInProgressError: class extends Error {},
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({ firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } } }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

// The caller authenticates as an application via a service token; the app id
// `test-app` matches ANTIPHONY_ORIGIN_APP_ID so credential + default tenancy
// agree. The acting end user arrives via the X-Antiphony-Acting-Actor header.
const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_ORIGIN_APP_ID = 'test-app';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN}`;

const { app } = await import('../../../app.js');
const { audioPostService } = await import('../../outbound/firebase/core-services-firebase.js');
const { checkIdempotency } = await import('../../../lib/idempotency.js');

const VIEW = {
    uri: 'at://u1/dev.antiphony.audio.post/p1',
    cid: 'p1',
    kind: 'prompt' as const,
    author: { id: 'u1', handle: 'alice', displayName: 'Alice' },
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
        it('returns the hydrated view (anonymous viewer allowed)', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(VIEW));
            const res = await app().request('/api/v1/posts/p1');
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.uri).toBe(VIEW.uri);
            expect(body.data.embed.url).toContain('signed');
            // Scoped to the configured origin app.
            expect(audioPostService.getPostView).toHaveBeenCalledWith('test-app', 'p1', null);
        });

        it('404s when the post is missing or belongs to another origin app', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(null));
            const res = await app().request('/api/v1/posts/nope');
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
    });

    describe('GET /:postId/replies', () => {
        it('404s when the parent post is missing', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(null));
            const res = await app().request('/api/v1/posts/p1/replies');
            expect(res.status).toBe(404);
            expect(audioPostService.getReplies).not.toHaveBeenCalled();
        });

        it('keys the thread query on the parent view uri', async () => {
            vi.mocked(audioPostService.getPostView).mockResolvedValue(asView(VIEW));
            vi.mocked(audioPostService.getReplies).mockResolvedValue([]);
            const res = await app().request('/api/v1/posts/p1/replies');
            expect(res.status).toBe(200);
            expect(audioPostService.getReplies).toHaveBeenCalledWith('test-app', VIEW.uri, null, expect.objectContaining({ limit: 50 }));
        });
    });
});
