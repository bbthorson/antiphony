import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({ audioPostService }),
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({ firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } } }),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

// `getAppDid` reads the boot-time validated-pin snapshot and throws without it.
// The uri it feeds is a fixed string here; `app-did.test.ts` covers resolution.
vi.mock('../../../lib/app-did.js', () => ({
    getAppDid: () => 'did:web:test-app.example',
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_ORIGIN_APP_ID = 'test-app';
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
            new Error('firestore exploded: connection string postgres://user:pw@host'),
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
});

// ---------------------------------------------------------------------------

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

    it('applies the origin lock, and refuses in the XRPC dialect', async () => {
        // Without this, `/xrpc/*` would be the one route into these domain
        // services that skips the CDN check the REST surface enforces.
        process.env.ANTIPHONY_ORIGIN_SECRET = 'x'.repeat(48);
        try {
            const res = await app().request('/xrpc/dev.antiphony.audio.getPost?id=p1', {
                headers: anonHeaders(),
            });

            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: 'Forbidden', message: 'Forbidden' });
        } finally {
            delete process.env.ANTIPHONY_ORIGIN_SECRET;
        }
    });

    it('404s an unknown method NSID', async () => {
        const res = await app().request('/xrpc/dev.antiphony.audio.notAMethod', {
            headers: anonHeaders(),
        });

        expect(res.status).toBe(404);
    });
});
