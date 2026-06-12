import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/prompts/public/:handle/:promptId` (legacy mobile).
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: { getUserData: vi.fn() },
    promptService: { getPromptData: vi.fn() },
    organizationService: {},
    hydrationService: {},
    feedService: {},
    rssService: {},
    StorageService: {},
    firebaseCoreServices: {},
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
const { userService, promptService } = await import('../../outbound/firebase/core-services-firebase.js');

type MockUser = { id: string; handle: string };
type MockPrompt = {
    record: { id: string; authorId: string; status: string; [k: string]: unknown };
    // Real prompts are always hydrated with an author; toPromptViewPublic projects it.
    author?: Record<string, unknown>;
    [k: string]: unknown;
};

function asUser(u: MockUser) {
    return u as unknown as Awaited<ReturnType<typeof userService.getUserData>>;
}

function asPrompt(p: MockPrompt) {
    return p as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>;
}

describe('GET /api/v1/prompts/public/:handle/:promptId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns { user, prompt } when both exist, prompt is live, and ownership matches', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({ id: 'u-1', handle: 'alice' }));
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPrompt({ record: { id: 'p-1', authorId: 'u-1', status: 'live' }, author: { id: 'u-1', handle: 'alice' } }),
        );

        const res = await app().request('/api/v1/prompts/public/alice/p-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.user.handle).toBe('alice');
        expect(body.data.prompt.record.id).toBe('p-1');
    });

    it('strips PII/admin fields from user, nested prompt author, and owner-only prompt fields', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({
            id: 'u-1', handle: 'alice', displayName: 'Alice',
            // PII / admin — must NOT reach an anonymous caller.
            email: 'alice@example.com', tier: 'creator_pro', lastSeenAt: '2026-06-01T00:00:00Z',
            unreadReplyCount: 5, phoneNumber: '+15551234567',
        } as unknown as MockUser));
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPrompt({
            record: { id: 'p-1', authorId: 'u-1', status: 'live', title: 'T', audioUrl: 'https://x/a.webm', createdAt: '2026-01-01T00:00:00Z' },
            author: { id: 'u-1', handle: 'alice', email: 'alice@example.com', tier: 'creator_pro' },
            replyCount: 3,
            // Owner-only prompt enrichment — must be stripped.
            analytics: { views: 99 },
            aiStatus: 'error',
            aiError: 'boom',
            aiSummary: 'private',
        }));

        const res = await app().request('/api/v1/prompts/public/alice/p-1');
        expect(res.status).toBe(200);
        const { data } = await res.json();

        for (const k of ['email', 'tier', 'lastSeenAt', 'unreadReplyCount', 'phoneNumber']) {
            expect(data.user[k]).toBeUndefined();
            expect(data.prompt.author[k]).toBeUndefined();
        }
        expect(data.user.handle).toBe('alice');
        expect(data.prompt.author.handle).toBe('alice');
        for (const k of ['analytics', 'aiStatus', 'aiError', 'aiSummary']) {
            expect(data.prompt[k]).toBeUndefined();
        }
        // Public surface still intact.
        expect(data.prompt.record.id).toBe('p-1');
        expect(data.prompt.record.title).toBe('T');
        expect(data.prompt.replyCount).toBe(3);
    });

    it('normalizes the handle (lowercases, strips leading @, URL-decodes)', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({ id: 'u-2', handle: 'bob' }));
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPrompt({ record: { id: 'p-2', authorId: 'u-2', status: 'live' }, author: { id: 'u-2', handle: 'bob' } }),
        );

        // `@Bob` URL-encoded = %40Bob.
        await app().request('/api/v1/prompts/public/%40Bob/p-2');

        // Normalized form should reach the service.
        expect(userService.getUserData).toHaveBeenCalledWith('bob');
    });

    it('returns 404 when the user does not exist', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPrompt({ record: { id: 'p-3', authorId: 'u-x', status: 'live' } }),
        );

        const res = await app().request('/api/v1/prompts/public/ghost/p-3');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'Prompt not found' },
        });
    });

    it('returns 404 when the prompt does not exist', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({ id: 'u-4', handle: 'carol' }));
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/prompts/public/carol/missing');

        expect(res.status).toBe(404);
    });

    it("returns 404 when the prompt's authorId doesn't match the user", async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({ id: 'u-5', handle: 'dave' }));
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPrompt({ record: { id: 'p-4', authorId: 'someone-else', status: 'live' } }),
        );

        const res = await app().request('/api/v1/prompts/public/dave/p-4');

        expect(res.status).toBe(404);
    });

    it("returns 404 when the prompt is not live", async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asUser({ id: 'u-6', handle: 'erin' }));
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPrompt({ record: { id: 'p-5', authorId: 'u-6', status: 'archived' } }),
        );

        const res = await app().request('/api/v1/prompts/public/erin/p-5');

        expect(res.status).toBe(404);
    });
});
