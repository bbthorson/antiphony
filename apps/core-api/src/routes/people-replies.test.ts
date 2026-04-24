import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/people/:handle/replies`.
 *
 * Auth-gated (requireAuth). Delegates to `feedService.getPersonReplies`
 * which returns `{ replies, promptTitles }`; replies are projected through
 * `toReplyViewPublic` before response.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    feedService: { getPersonReplies: vi.fn() },
    userService: {},
    promptService: {},
    replyService: {},
    organizationService: {},
    firebaseCoreServices: {},
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
const { feedService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

describe('GET /api/v1/people/:handle/replies', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/people/someone/replies');
        expect(res.status).toBe(401);
    });

    it('returns replies + promptTitles for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-p1' });
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
            author: { id: 'them', handle: 'target-person' },
            recipient: { id: 'viewer-p1', handle: 'me' },
            isRead: true,
            isDeleted: false,
            isVerified: false,
            readBy: [],
            authorRating: 3,
            listenerPhoneNumber: '+15555559999',
        };
        vi.mocked(feedService.getPersonReplies).mockResolvedValue({
            replies: [fakeReply],
            promptTitles: { 'p-1': 'Hello' },
        } as unknown as Awaited<ReturnType<typeof feedService.getPersonReplies>>);

        const res = await app().request('/api/v1/people/target-person/replies', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.promptTitles).toEqual({ 'p-1': 'Hello' });
        expect(body.replies).toHaveLength(1);
        // Public projection strips CRM-only fields.
        expect(body.replies[0].authorRating).toBeUndefined();
        expect(body.replies[0].listenerPhoneNumber).toBeUndefined();
        expect(body.replies[0].record.notes).toBeUndefined();
    });

    it('forwards the viewer uid + handle to feedService', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-p2' });
        vi.mocked(feedService.getPersonReplies).mockResolvedValue({
            replies: [],
            promptTitles: {},
        });

        await app().request('/api/v1/people/some-handle/replies', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(vi.mocked(feedService.getPersonReplies)).toHaveBeenCalledWith(
            'viewer-p2',
            'some-handle',
        );
    });

    it('maps service errors to 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-p3' });
        vi.mocked(feedService.getPersonReplies).mockRejectedValue(new Error('boom'));

        const res = await app().request('/api/v1/people/x/replies', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(500);
        expect((await res.json()).requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
