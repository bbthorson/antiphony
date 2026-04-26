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
        createReplyTransaction: vi.fn(),
        getRepliesForPrompt: vi.fn(),
    },
    promptService: {
        getPromptRecord: vi.fn(),
        getPromptData: vi.fn(),
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

const resolvePendingFn = vi.fn();
const consumePendingFn = vi.fn();
vi.mock('../lib/pending-uploads.js', () => ({
    resolvePendingUpload: (id: string, promptId: string) => resolvePendingFn(id, promptId),
    consumePendingUpload: (id: string) => consumePendingFn(id),
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

describe('POST /api/v1/replies', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        resolvePendingFn.mockReset();
        consumePendingFn.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ promptId: 'p-1', audioUrl: 'https://audio' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s when neither audioUrl nor pendingUploadId is provided', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request(
            '/api/v1/replies',
            jsonInit({ promptId: 'p-1' }),
        );
        expect(res.status).toBe(400);
    });

    it('400s when both audioUrl and pendingUploadId are provided', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request(
            '/api/v1/replies',
            jsonInit({
                promptId: 'p-1',
                audioUrl: 'https://audio/x.m4a',
                pendingUploadId: 'pend_abc',
            }),
        );
        expect(res.status).toBe(400);
    });

    it('creates via audioUrl branch and returns the hydrated reply', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-c' });
        vi.mocked(replyService.createReplyTransaction).mockResolvedValue({
            record: { id: 'r-new', promptId: 'p-1', authorId: 'u-c', notes: 'secret' },
            author: { id: 'u-c' },
        } as unknown as Awaited<ReturnType<typeof replyService.createReplyTransaction>>);

        const res = await app().request(
            '/api/v1/replies',
            jsonInit({ promptId: 'p-1', audioUrl: 'https://audio/x.m4a' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        // ReplyViewPublic strips `record.notes`.
        expect(body.reply.record.notes).toBeUndefined();
        expect(replyService.createReplyTransaction).toHaveBeenCalledWith('u-c', {
            promptId: 'p-1',
            audioUrl: 'https://audio/x.m4a',
        });
        expect(resolvePendingFn).not.toHaveBeenCalled();
        expect(consumePendingFn).not.toHaveBeenCalled();
    });

    it('404s when the pendingUploadId cannot be resolved', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-p' });
        resolvePendingFn.mockResolvedValue(null);

        const res = await app().request(
            '/api/v1/replies',
            jsonInit({ promptId: 'p-1', pendingUploadId: 'pend_missing' }),
        );

        expect(res.status).toBe(404);
        expect(replyService.createReplyTransaction).not.toHaveBeenCalled();
    });

    it('creates via pendingUploadId branch and cleans up the pending row after', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-pend' });
        resolvePendingFn.mockResolvedValue({
            id: 'pend_ok',
            audioUrl: 'https://pending-storage/ok.m4a',
            promptId: 'p-e',
        });
        vi.mocked(replyService.createReplyTransaction).mockResolvedValue({
            record: { id: 'r-e', promptId: 'p-e', authorId: 'u-pend' },
            author: { id: 'u-pend' },
        } as unknown as Awaited<ReturnType<typeof replyService.createReplyTransaction>>);
        consumePendingFn.mockResolvedValue(undefined);

        const res = await app().request(
            '/api/v1/replies',
            jsonInit({ promptId: 'p-e', pendingUploadId: 'pend_ok' }),
        );

        expect(res.status).toBe(200);
        expect(resolvePendingFn).toHaveBeenCalledWith('pend_ok', 'p-e');
        expect(replyService.createReplyTransaction).toHaveBeenCalledWith('u-pend', {
            promptId: 'p-e',
            audioUrl: 'https://pending-storage/ok.m4a',
        });
        expect(consumePendingFn).toHaveBeenCalledWith('pend_ok');
    });
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

describe('GET /api/v1/replies (list by prompt)', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('400s without promptId', async () => {
        const res = await app().request('/api/v1/replies');
        expect(res.status).toBe(400);
    });

    it('404s when the prompt does not exist', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/replies?promptId=missing');

        expect(res.status).toBe(404);
    });

    it('returns replies projected through toReplyViewPublic for an anonymous viewer', async () => {
        const fakePrompt = {
            record: { id: 'p-1', authorId: 'author-1', status: 'live' },
            author: { id: 'author-1', handle: 'host' },
            visibility: 'public',
        };
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            fakePrompt as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>,
        );
        const fakeReply = {
            record: {
                id: 'r-1',
                promptId: 'p-1',
                authorId: 'them',
                createdAt: new Date().toISOString(),
                status: 'live',
                audioUrl: 'https://x',
                notes: 'private',
            },
            author: { id: 'them' },
            recipient: { id: 'author-1' },
            isRead: false,
            isDeleted: false,
            isVerified: false,
            readBy: [],
            authorRating: 5,
            listenerPhoneNumber: '+15555555555',
        };
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([
            fakeReply,
        ] as unknown as Awaited<ReturnType<typeof replyService.getRepliesForPrompt>>);

        const res = await app().request('/api/v1/replies?promptId=p-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.replies).toHaveLength(1);
        // Public projection strips CRM-only fields.
        expect(body.replies[0].authorRating).toBeUndefined();
        expect(body.replies[0].listenerPhoneNumber).toBeUndefined();
        expect(body.replies[0].record.notes).toBeUndefined();
        // Anonymous viewer → uid is empty string.
        expect(vi.mocked(replyService.getRepliesForPrompt)).toHaveBeenCalledWith(
            '',
            { id: 'p-1', authorId: 'author-1', status: 'live' },
            fakePrompt.author,
            { includeArchived: false },
        );
    });

    it('forwards includeArchived=true and uses prompt.record.status (not visibility)', async () => {
        // Owner viewing their own archived prompt — passes the visibility gate
        // because isOwner=true. status carries through to ReplyService.
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'author-2' });
        const fakePrompt = {
            record: { id: 'p-2', authorId: 'author-2', status: 'archived' },
            author: { id: 'author-2', handle: 'host2' },
            visibility: 'public',
        };
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            fakePrompt as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>,
        );
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([]);

        await app().request('/api/v1/replies?promptId=p-2&includeArchived=true', {
            headers: { authorization: 'Bearer owner-token' },
        });

        expect(vi.mocked(replyService.getRepliesForPrompt)).toHaveBeenCalledWith(
            'author-2',
            { id: 'p-2', authorId: 'author-2', status: 'archived' },
            fakePrompt.author,
            { includeArchived: true },
        );
    });

    it('404s when the prompt is private and viewer is not owner (visibility gate)', async () => {
        const fakePrompt = {
            record: { id: 'p-priv', authorId: 'someone-else', status: 'live' },
            author: { id: 'someone-else', handle: 'priv-host' },
            visibility: 'private',
        };
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            fakePrompt as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>,
        );

        const res = await app().request('/api/v1/replies?promptId=p-priv');

        expect(res.status).toBe(404);
        // ReplyService should never be called when the visibility gate fires.
        expect(vi.mocked(replyService.getRepliesForPrompt)).not.toHaveBeenCalled();
    });

    it('404s when the prompt is non-live and viewer is anonymous', async () => {
        const fakePrompt = {
            record: { id: 'p-arch', authorId: 'someone-else', status: 'archived' },
            author: { id: 'someone-else', handle: 'arch-host' },
            visibility: 'public',
        };
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            fakePrompt as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>,
        );

        const res = await app().request('/api/v1/replies?promptId=p-arch');

        expect(res.status).toBe(404);
        expect(vi.mocked(replyService.getRepliesForPrompt)).not.toHaveBeenCalled();
    });
});
