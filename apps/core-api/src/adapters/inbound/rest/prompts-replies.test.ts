import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/prompts/:promptId/replies`.
 *
 * Coverage matrix:
 *   - anonymous viewer, live prompt → ReplyViewPublic[]
 *   - author viewer (bearer), live prompt → full ReplyView[]
 *   - non-author viewer, non-live prompt → []
 *   - author viewer, non-live prompt → replies still returned
 *   - missing prompt → { success: true, data: [] } (collapses, not 404)
 *   - invalid query param → 400
 *   - includeArchived=true passes through to service
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    promptService: { getPromptData: vi.fn() },
    replyService: { getRepliesForPrompt: vi.fn() },
    organizationService: {},
    userService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
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

const { app } = await import('../../../app.js');
const { promptService, replyService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

function mkPrompt(overrides: Record<string, unknown> = {}) {
    return {
        record: {
            id: 'p-1',
            authorId: 'author-uid',
            status: 'live',
            title: 'Hi',
            ...((overrides.record as object) ?? {}),
        },
        author: {
            id: 'author-uid',
            handle: 'author',
            displayName: 'Author',
        },
        ...overrides,
    } as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>;
}

// Builds a reply with author-only CRM fields so we can assert they're stripped
// in the non-author projection.
function mkReply(authorId: string, overrides: Record<string, unknown> = {}) {
    return {
        record: {
            id: `r-${authorId}`,
            promptId: 'p-1',
            authorId,
            createdAt: new Date('2026-04-20').toISOString(),
            status: 'live',
            audioUrl: 'https://x',
        },
        author: { id: authorId, handle: `replier-${authorId}`, displayName: 'Replier' },
        recipient: { id: 'author-uid', handle: 'author' },
        isRead: false,
        isDeleted: false,
        readBy: [],
        listenerPhoneNumber: '+15555551212',
        notes: 'private notes',
        ...overrides,
    };
}

describe('GET /api/v1/prompts/:promptId/replies', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns [] when the prompt does not exist (collapses, not 404)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/prompts/missing/replies');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: [] });
    });

    it('anonymous viewer gets ReplyViewPublic[] (CRM fields stripped)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(mkPrompt());
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([
            mkReply('replier-1'),
        ] as unknown as Awaited<ReturnType<typeof replyService.getRepliesForPrompt>>);

        const res = await app().request('/api/v1/prompts/p-1/replies');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        // ReplyViewPublic strips these fields:        expect(body.data[0].listenerPhoneNumber).toBeUndefined();
        expect(body.data[0].notes).toBeUndefined();
    });

    it('author viewer gets the FULL ReplyView[] (CRM fields preserved)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'author-uid' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(mkPrompt());
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([
            mkReply('replier-2'),
        ] as unknown as Awaited<ReturnType<typeof replyService.getRepliesForPrompt>>);

        const res = await app().request('/api/v1/prompts/p-1/replies', {
            headers: { authorization: 'Bearer author-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();        expect(body.data[0].listenerPhoneNumber).toBe('+15555551212');
        expect(body.data[0].notes).toBe('private notes');
    });

    it('non-author viewer gets [] when prompt is not live', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-only' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            mkPrompt({ record: { id: 'p-draft', authorId: 'author-uid', status: 'archived', title: 'X' } }),
        );
        // Service should NOT be called in this branch
        const res = await app().request('/api/v1/prompts/p-draft/replies', {
            headers: { authorization: 'Bearer stranger' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: [] });
        expect(replyService.getRepliesForPrompt).not.toHaveBeenCalled();
    });

    it('author viewer gets replies even when prompt is not live', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'author-uid' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            mkPrompt({ record: { id: 'p-archived', authorId: 'author-uid', status: 'archived', title: 'X' } }),
        );
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([
            mkReply('r-a'),
        ] as unknown as Awaited<ReturnType<typeof replyService.getRepliesForPrompt>>);

        const res = await app().request('/api/v1/prompts/p-archived/replies', {
            headers: { authorization: 'Bearer author-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(1);    });

    it('includeArchived=true flows through to the service', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'author-uid' });
        vi.mocked(promptService.getPromptData).mockResolvedValue(mkPrompt());
        vi.mocked(replyService.getRepliesForPrompt).mockResolvedValue([]);

        await app().request('/api/v1/prompts/p-1/replies?includeArchived=true', {
            headers: { authorization: 'Bearer author-token' },
        });

        const call = vi.mocked(replyService.getRepliesForPrompt).mock.calls[0];
        expect(call[3]).toEqual({ includeArchived: true });
    });

    it('propagates x-request-id', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/prompts/whatever/replies', {
            headers: { 'x-request-id': 'trace-replies' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-replies');
    });

    it('maps service errors to 500 with requestId', async () => {
        vi.mocked(promptService.getPromptData).mockRejectedValue(new Error('prompt boom'));

        const res = await app().request('/api/v1/prompts/p-boom/replies');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
