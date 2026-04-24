import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Smoke tests for `GET /api/v1/inbox`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    userService: { getUserDataByUid: vi.fn() },
    promptService: { getPromptsForUser: vi.fn() },
    replyService: { getRepliesForPrompts: vi.fn() },
    organizationService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
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
const { userService, promptService, replyService } = await import(
    '../services/core-services-firebase.js'
);
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

describe('GET /api/v1/inbox', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/inbox');
        expect(res.status).toBe(401);
    });

    it('404s when profile is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-orphan' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(null);

        const res = await app().request('/api/v1/inbox', {
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(404);
    });

    it('short-circuits to empty replies when user has no prompts', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-empty' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue({
            id: 'u-empty',
            handle: 'nobody',
        } as unknown as Awaited<ReturnType<typeof userService.getUserDataByUid>>);
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue([]);

        const res = await app().request('/api/v1/inbox', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ replies: [] });
        expect(replyService.getRepliesForPrompts).not.toHaveBeenCalled();
    });

    it('returns hydrated replies, flattened and sorted by date desc', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-busy' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue({
            id: 'u-busy',
            handle: 'busy',
        } as unknown as Awaited<ReturnType<typeof userService.getUserDataByUid>>);
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue([
            { record: { id: 'p-1' } },
            { record: { id: 'p-2' } },
        ] as unknown as Awaited<ReturnType<typeof promptService.getPromptsForUser>>);

        const older = {
            record: { id: 'r-old', promptId: 'p-1', createdAt: '2026-04-01' },
            author: { id: 'a' },
        };
        const newer = {
            record: { id: 'r-new', promptId: 'p-2', createdAt: '2026-04-20' },
            author: { id: 'b' },
        };
        vi.mocked(replyService.getRepliesForPrompts).mockResolvedValue(
            new Map([
                ['p-1', [older]],
                ['p-2', [newer]],
            ]) as unknown as Awaited<ReturnType<typeof replyService.getRepliesForPrompts>>,
        );

        const res = await app().request('/api/v1/inbox', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.replies).toHaveLength(2);
        expect(body.replies[0].record.id).toBe('r-new');
        expect(body.replies[1].record.id).toBe('r-old');
    });
});
