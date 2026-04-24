import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ForbiddenError } from 'shared/errors';

/**
 * Tests for the reply-write endpoints (Batch A4).
 *
 * All five share:
 *   - requireAuth → 401 without bearer
 *   - invalid JSON / schema → 400
 *   - service/dep mock controls outcomes
 *
 * Ownership checks are verified at the boundary — for /notes and
 * /update-author-data (route-level checks), and for /status + bulk (service
 * throws ForbiddenError, mapped to 403 by the error-handler).
 */

vi.mock('../services/core-services-firebase.js', () => ({
    replyService: {
        updateReplyStatus: vi.fn(),
        getReplyRecord: vi.fn(),
        updateReplyNotes: vi.fn(),
        bulkMarkRead: vi.fn(),
        bulkUpdateStatus: vi.fn(),
    },
    promptService: {
        getPromptRecord: vi.fn(),
    },
    userService: {},
    organizationService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../services/replies-dependencies.js', () => ({
    firebaseReplyDependencies: {
        markReplyRead: vi.fn(),
        updateReply: vi.fn(),
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
const { replyService, promptService } = await import('../services/core-services-firebase.js');
const { firebaseReplyDependencies } = await import('../services/replies-dependencies.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

function asReply(v: Record<string, unknown>) {
    return v as unknown as Awaited<ReturnType<typeof replyService.getReplyRecord>>;
}
function asPrompt(v: Record<string, unknown>) {
    return v as unknown as Awaited<ReturnType<typeof promptService.getPromptRecord>>;
}

const jsonInit = (body: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ok',
        ...extra,
    },
    body: JSON.stringify(body),
});
const jsonPatch = (body: unknown) => ({
    ...jsonInit(body),
    method: 'PATCH',
});

describe('PATCH /api/v1/replies/:replyId/status', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/r-1/status', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'archived' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid JSON', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/replies/r-1/status', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: 'not-json',
        });
        expect(res.status).toBe(400);
    });

    it('400s on invalid status enum', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/replies/r-1/status', jsonPatch({ status: 'nope' }));
        expect(res.status).toBe(400);
    });

    it('calls updateReplyStatus and returns success', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(replyService.updateReplyStatus).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/replies/r-99/status', jsonPatch({ status: 'archived' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'success' });
        expect(replyService.updateReplyStatus).toHaveBeenCalledWith('r-99', 'archived', 'u-1');
    });

    it('maps ForbiddenError from the service to a 403', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(replyService.updateReplyStatus).mockRejectedValue(
            new ForbiddenError('You do not own the prompt for this reply.'),
        );
        const res = await app().request('/api/v1/replies/r-1/status', jsonPatch({ status: 'live' }));
        expect(res.status).toBe(403);
    });

    it('maps NotFoundError from the service to a 404', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(replyService.updateReplyStatus).mockRejectedValue(new NotFoundError('Reply not found'));
        const res = await app().request('/api/v1/replies/missing/status', jsonPatch({ status: 'live' }));
        expect(res.status).toBe(404);
    });
});

describe('POST /api/v1/replies/:replyId/read', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/r-1/read', { method: 'POST' });
        expect(res.status).toBe(401);
    });

    it('calls markReplyRead and returns success', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-read' });
        vi.mocked(firebaseReplyDependencies.markReplyRead).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/replies/r-read/read', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(firebaseReplyDependencies.markReplyRead).toHaveBeenCalledWith('r-read', 'u-read');
    });
});

describe('POST /api/v1/replies/:replyId/notes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/r-1/notes', jsonInit({ notes: 'hi' }, {}));
        // Re-run without authorization — override defaults.
        const res2 = await app().request('/api/v1/replies/r-1/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ notes: 'hi' }),
        });
        expect(res2.status).toBe(401);
        void res; // unused; keeping the explicit headerless case distinct
    });

    it('404s when reply is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-n' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(null);
        const res = await app().request('/api/v1/replies/r-miss/notes', jsonInit({ notes: 'hi' }));
        expect(res.status).toBe(404);
        expect((await res.json()).message).toBe('Reply not found');
    });

    it('404s when parent prompt is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-n' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-gone', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(null);
        const res = await app().request('/api/v1/replies/r-1/notes', jsonInit({ notes: 'hi' }));
        expect(res.status).toBe(404);
        expect((await res.json()).message).toBe('Prompt not found');
    });

    it('403s when viewer is not the prompt author', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'not-author' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-1', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(asPrompt({ id: 'p-1', authorId: 'owner' }));
        const res = await app().request('/api/v1/replies/r-1/notes', jsonInit({ notes: 'hi' }));
        expect(res.status).toBe(403);
    });

    it('updates notes when viewer owns the prompt', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'owner' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-1', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(asPrompt({ id: 'p-1', authorId: 'owner' }));
        vi.mocked(replyService.updateReplyNotes).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/replies/r-1/notes', jsonInit({ notes: 'updated' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(replyService.updateReplyNotes).toHaveBeenCalledWith('r-1', 'updated');
    });
});

describe('POST /api/v1/replies/bulk-action', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/bulk-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ replyIds: ['r-1'], action: 'markRead' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid action', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-b' });
        const res = await app().request(
            '/api/v1/replies/bulk-action',
            jsonInit({ replyIds: ['r-1'], action: 'frobnicate' }),
        );
        expect(res.status).toBe(400);
    });

    it('dispatches markRead via bulkMarkRead', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-b' });
        vi.mocked(replyService.bulkMarkRead).mockResolvedValue(undefined);
        const res = await app().request(
            '/api/v1/replies/bulk-action',
            jsonInit({ replyIds: ['r-1', 'r-2'], action: 'markRead' }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'success', count: 2 });
        expect(replyService.bulkMarkRead).toHaveBeenCalledWith(['r-1', 'r-2'], 'u-b');
    });

    it('dispatches archive/delete/restore via bulkUpdateStatus', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-b' });
        vi.mocked(replyService.bulkUpdateStatus).mockResolvedValue(undefined);

        for (const [action, expected] of [
            ['archive', 'archived'],
            ['delete', 'deleted'],
            ['restore', 'live'],
        ] as const) {
            vi.mocked(replyService.bulkUpdateStatus).mockClear();
            const res = await app().request(
                '/api/v1/replies/bulk-action',
                jsonInit({ replyIds: [`r-${action}`], action }),
            );
            expect(res.status).toBe(200);
            expect(replyService.bulkUpdateStatus).toHaveBeenCalledWith(
                [`r-${action}`],
                expected,
                'u-b',
            );
        }
    });
});

describe('POST /api/v1/replies/update-author-data', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/update-author-data', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ replyId: 'r-1', data: { authorRating: 5 } }),
        });
        expect(res.status).toBe(401);
    });

    it('404s when reply missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-u' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(null);
        const res = await app().request(
            '/api/v1/replies/update-author-data',
            jsonInit({ replyId: 'r-miss', data: { authorRating: 5 } }),
        );
        expect(res.status).toBe(404);
    });

    it('404s when prompt missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-u' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-gone', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(null);
        const res = await app().request(
            '/api/v1/replies/update-author-data',
            jsonInit({ replyId: 'r-1', data: { authorRating: 5 } }),
        );
        expect(res.status).toBe(404);
        expect((await res.json()).message).toContain('prompt');
    });

    it('403s when viewer is not prompt author', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'not-me' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-1', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(asPrompt({ id: 'p-1', authorId: 'owner' }));
        const res = await app().request(
            '/api/v1/replies/update-author-data',
            jsonInit({ replyId: 'r-1', data: { authorRating: 5 } }),
        );
        expect(res.status).toBe(403);
    });

    it('updates the reply via the deps layer when owner', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'owner' });
        vi.mocked(replyService.getReplyRecord).mockResolvedValue(asReply({ id: 'r-1', promptId: 'p-1', authorId: 'x' }));
        vi.mocked(promptService.getPromptRecord).mockResolvedValue(asPrompt({ id: 'p-1', authorId: 'owner' }));
        vi.mocked(firebaseReplyDependencies.updateReply).mockResolvedValue(undefined);

        const res = await app().request(
            '/api/v1/replies/update-author-data',
            jsonInit({
                replyId: 'r-1',
                data: { authorRating: 4, authorTags: ['thoughtful'], isVerified: true },
            }),
        );

        expect(res.status).toBe(200);
        expect(firebaseReplyDependencies.updateReply).toHaveBeenCalledWith('r-1', {
            authorRating: 4,
            authorTags: ['thoughtful'],
            isVerified: true,
        });
    });
});
