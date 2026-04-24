import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/prompts/:promptId`.
 *
 * Pre-bearer-bridge scope: `viewerUid = null` (anonymous viewer) — the
 * owner branch is dead code for now. These tests cover the anonymous
 * path: all successful responses go through `toPromptViewPublic`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    promptService: {
        getPromptData: vi.fn(),
        validateAndCreatePrompt: vi.fn(),
        updatePrompt: vi.fn(),
        getPromptRecord: vi.fn(),
        updatePromptStatus: vi.fn(),
        deletePrompt: vi.fn(),
    },
    organizationService: {
        isMember: vi.fn(),
    },
    userService: {},
    hydrationService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../services/replies-dependencies.js', () => ({
    firebaseReplyDependencies: {
        queryByPromptId: vi.fn(),
        bulkMarkRepliesRead: vi.fn(),
    },
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async (fn: (t: unknown) => Promise<boolean>) =>
            fn({
                get: async () => ({ exists: false, data: () => undefined }),
                set: () => undefined,
                update: () => undefined,
            }),
    }),
    getAdmin: () => ({
        firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } },
    }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../app.js');
const { promptService, organizationService } = await import('../services/core-services-firebase.js');
const { firebaseReplyDependencies } = await import('../services/replies-dependencies.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

type MockPromptView = ReturnType<typeof mkPrompt>;

/**
 * Build a minimal PromptView shape. Includes owner-only fields
 * (analytics / moderation / aiSummary) so the stripping test can assert
 * they're gone in the public projection. Typed as `unknown` then cast
 * at the mock-resolve site to avoid `any` while keeping the fixture terse.
 */
function mkPrompt(overrides: { record?: Record<string, unknown>; visibility?: string } = {}) {
    return {
        record: {
            id: 'p-1',
            authorId: 'author-1',
            title: 'Hello',
            status: 'live',
            createdAt: new Date().toISOString(),
            audioUrl: 'https://example.com/a.mp3',
            ...overrides.record,
        },
        author: {
            id: 'author-1',
            handle: 'alice',
            displayName: 'Alice',
            email: 'leak@example.com', // only on full ProfileView; stripped in Basic
        },
        replyCount: 3,
        lastReplyAt: null,
        likeCount: 0,
        visibility: overrides.visibility ?? 'public',
        analytics: { listens: 42 }, // owner-only
        moderation: { flagged: false }, // owner-only
        aiSummary: 'owner-only summary', // owner-only
    };
}

// Helper: satisfy vi.mocked's return type without threading the full
// `PromptView` type through every fixture.
function asPromptView(v: MockPromptView) {
    return v as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>;
}

describe('GET /api/v1/prompts/:promptId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the public projection (anonymous viewer — owner fields stripped)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt()));

        const res = await app().request('/api/v1/prompts/p-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('p-1');
        // Owner-only fields stripped.
        expect(body.data.analytics).toBeUndefined();
        expect(body.data.moderation).toBeUndefined();
        expect(body.data.aiSummary).toBeUndefined();
    });

    it('returns 404 when the prompt does not exist', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/prompts/missing');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'Prompt not found' });
    });

    it('returns 404 for non-live prompts (existence is hidden from non-owners)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPromptView(mkPrompt({ record: { id: 'p-archive', authorId: 'a', status: 'archived' } })),
        );

        const res = await app().request('/api/v1/prompts/p-archive');

        expect(res.status).toBe(404);
    });

    it('returns 404 for private-visibility prompts to non-owners', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPromptView(mkPrompt({ visibility: 'private' })),
        );

        const res = await app().request('/api/v1/prompts/p-priv');

        expect(res.status).toBe(404);
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt({ record: { id: 'p-hdr', authorId: 'a' } })));

        const res = await app().request('/api/v1/prompts/p-hdr', {
            headers: { 'x-request-id': 'trace-xyz' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-xyz');
    });

    it('returns the FULL view (owner-only fields) when viewer is the author', async () => {
        // `mkPrompt` default authorId is 'author-1'. Viewer uid matches.
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'author-1' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt()));

        const res = await app().request('/api/v1/prompts/p-1', {
            headers: { authorization: 'Bearer owner-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        // Owner-only fields present (not stripped).
        expect(body.data.analytics).toEqual({ listens: 42 });
        expect(body.data.moderation).toEqual({ flagged: false });
        expect(body.data.aiSummary).toBe('owner-only summary');
    });

    it('still strips owner-only fields when viewer is authenticated but NOT the author', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'different-user' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt()));

        const res = await app().request('/api/v1/prompts/p-not-mine', {
            headers: { authorization: 'Bearer other-user-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.analytics).toBeUndefined();
    });

    it('treats an invalid token as anonymous (still public projection, not 401)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockRejectedValue(new Error('expired'));
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt()));

        const res = await app().request('/api/v1/prompts/p-expired', {
            headers: { authorization: 'Bearer expired-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.analytics).toBeUndefined();
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(promptService.getPromptData).mockRejectedValue(new Error('firestore down'));

        const res = await app().request('/api/v1/prompts/p-boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

const jsonReq = (body: unknown, method: string) => ({
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
    body: JSON.stringify(body),
});

describe('POST /api/v1/prompts', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'T', audioUrl: 'https://x' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid JSON', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: 'not-json',
        });
        expect(res.status).toBe(400);
    });

    it('400s on schema failure', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/prompts', jsonReq({ title: 'Title' }, 'POST'));
        // Missing audioUrl.
        expect(res.status).toBe(400);
    });

    it('creates a prompt and returns the id', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-create' });
        vi.mocked(promptService.validateAndCreatePrompt).mockResolvedValue({
            id: 'p-new',
        } as unknown as Awaited<ReturnType<typeof promptService.validateAndCreatePrompt>>);

        const res = await app().request(
            '/api/v1/prompts',
            jsonReq({ title: 'Hello prompt', audioUrl: 'https://audio/x.m4a' }, 'POST'),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, promptId: 'p-new' });
        expect(promptService.validateAndCreatePrompt).toHaveBeenCalledWith({
            title: 'Hello prompt',
            description: '',
            audioUrl: 'https://audio/x.m4a',
            authorId: 'u-create',
            orgId: null,
            createdBy: 'u-create',
        });
    });

    it('403s when viewer claims currentOrg but is not a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-out', currentOrg: 'org-1' });
        vi.mocked(organizationService.isMember).mockResolvedValue(false);

        const res = await app().request(
            '/api/v1/prompts',
            jsonReq({ title: 'Title', audioUrl: 'https://audio' }, 'POST'),
        );
        expect(res.status).toBe(403);
    });

    it('uses currentOrg from session when viewer is a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-org', currentOrg: 'org-2' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.validateAndCreatePrompt).mockResolvedValue({
            id: 'p-in-org',
        } as unknown as Awaited<ReturnType<typeof promptService.validateAndCreatePrompt>>);

        await app().request(
            '/api/v1/prompts',
            jsonReq({ title: 'Title', audioUrl: 'https://audio' }, 'POST'),
        );

        const call = vi.mocked(promptService.validateAndCreatePrompt).mock.calls[0][0];
        expect(call.orgId).toBe('org-2');
    });

    it('setAsGreeting updates the inbox prompt best-effort', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-g' });
        vi.mocked(promptService.validateAndCreatePrompt).mockResolvedValue({
            id: 'p-g',
        } as unknown as Awaited<ReturnType<typeof promptService.validateAndCreatePrompt>>);
        vi.mocked(promptService.updatePrompt).mockResolvedValue(undefined);

        await app().request(
            '/api/v1/prompts',
            jsonReq(
                {
                    title: 'Greeting audio',
                    audioUrl: 'https://audio/greet.m4a',
                    setAsGreeting: true,
                },
                'POST',
            ),
        );

        expect(promptService.updatePrompt).toHaveBeenCalledWith('inbox_u-g', {
            audioUrl: 'https://audio/greet.m4a',
        });
    });
});

describe('PATCH /api/v1/prompts/:promptId/status', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/prompts/p-1/status', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'archived' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on bad status', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/prompts/p-1/status', jsonReq({ status: 'nope' }, 'PATCH'));
        expect(res.status).toBe(400);
    });

    it('404s when the prompt is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(null);
        const res = await app().request(
            '/api/v1/prompts/p-miss/status',
            jsonReq({ status: 'archived' }, 'PATCH'),
        );
        expect(res.status).toBe(404);
    });

    it('403s when viewer does not own and is not an org member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'not-owner' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue({
            id: 'p-1',
            authorId: 'owner',
        } as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>);
        vi.mocked(organizationService.isMember).mockResolvedValue(false);

        const res = await app().request('/api/v1/prompts/p-1/status', jsonReq({ status: 'archived' }, 'PATCH'));
        expect(res.status).toBe(403);
    });

    it('succeeds when viewer is the owner', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'owner' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue({
            id: 'p-1',
            authorId: 'owner',
        } as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>);
        vi.mocked(promptService.updatePromptStatus).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/prompts/p-1/status', jsonReq({ status: 'archived' }, 'PATCH'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, status: 'archived' });
    });

    it('allows an org member (author treated as org id)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'member' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue({
            id: 'p-org',
            authorId: 'org-id',
        } as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>);
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.updatePromptStatus).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/prompts/p-org/status', jsonReq({ status: 'live' }, 'PATCH'));
        expect(res.status).toBe(200);
    });
});

describe('DELETE /api/v1/prompts/:promptId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/prompts/p-1', { method: 'DELETE' });
        expect(res.status).toBe(401);
    });

    it('404s when prompt is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(null);
        const res = await app().request('/api/v1/prompts/p-miss', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(404);
    });

    it('succeeds for owner', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'owner' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue({
            id: 'p-d',
            authorId: 'owner',
        } as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>);
        vi.mocked(promptService.deletePrompt).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/prompts/p-d', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(200);
        expect(promptService.deletePrompt).toHaveBeenCalledWith('p-d');
    });

    it('403s for non-owner non-member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'x' });
        vi.mocked(promptService.getPromptRecord).mockResolvedValue({
            id: 'p-f',
            authorId: 'y',
        } as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>);
        vi.mocked(organizationService.isMember).mockResolvedValue(false);

        const res = await app().request('/api/v1/prompts/p-f', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(403);
    });
});

describe('POST /api/v1/prompts/:promptId/read', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/prompts/p-1/read', { method: 'POST' });
        expect(res.status).toBe(401);
    });

    it('short-circuits when there are no replies', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-r' });
        vi.mocked(firebaseReplyDependencies.queryByPromptId).mockResolvedValue([]);

        const res = await app().request('/api/v1/prompts/p-empty/read', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(firebaseReplyDependencies.bulkMarkRepliesRead).not.toHaveBeenCalled();
    });

    it('bulk-marks all replies read when there are some', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-r' });
        vi.mocked(firebaseReplyDependencies.queryByPromptId).mockResolvedValue([
            { id: 'r-1' },
            { id: 'r-2' },
        ] as unknown as Awaited<ReturnType<typeof firebaseReplyDependencies.queryByPromptId>>);
        vi.mocked(firebaseReplyDependencies.bulkMarkRepliesRead).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/prompts/p-has/read', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(firebaseReplyDependencies.bulkMarkRepliesRead).toHaveBeenCalledWith(
            ['r-1', 'r-2'],
            'u-r',
        );
    });
});
