import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/replies/search`.
 *
 * Auth-gated (requireAuth). Validates the min-length-2 query constraint.
 * Filters (`promptId`, `status`, `readStatus`, `dateFrom`, `dateTo`) are
 * parsed from query string and passed to `replyService.searchReplies`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    replyService: { searchReplies: vi.fn() },
    userService: {},
    promptService: {},
    feedService: {},
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
const { replyService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

describe('GET /api/v1/replies/search', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/search?q=hello');
        expect(res.status).toBe(401);
    });

    it('400s when q is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v1' });
        const res = await app().request('/api/v1/replies/search', {
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.status).toBe('error');
        // Zod surfaces "Required" for missing fields — the length-check
        // message is exercised by the "too short" case below.
        expect(body.message).toBeTruthy();
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('400s when q is too short (1 char)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v2' });
        const res = await app().request('/api/v1/replies/search?q=a', {
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(400);
    });

    it('forwards query + filters to searchReplies, returns public projection', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v3' });
        const fakeReply = {
            record: {
                id: 'r-x',
                promptId: 'p-x',
                authorId: 'them',
                createdAt: new Date().toISOString(),
                status: 'live',
                audioUrl: 'https://x',
                notes: 'secret',
            },
            author: { id: 'them' },
            recipient: { id: 'v3' },
            isRead: false,
            isDeleted: false,
            isVerified: false,
            readBy: [],
            listenerPhoneNumber: '+15555554444',
        };
        vi.mocked(replyService.searchReplies).mockResolvedValue([fakeReply] as unknown as Awaited<
            ReturnType<typeof replyService.searchReplies>
        >);

        const res = await app().request(
            '/api/v1/replies/search?q=hello&promptId=p-x&status=archived&readStatus=unread&dateFrom=2026-01-01&dateTo=2026-04-01',
            { headers: { authorization: 'Bearer ok' } },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.query).toBe('hello');
        expect(body.replies).toHaveLength(1);
        expect(body.replies[0].listenerPhoneNumber).toBeUndefined();
        expect(body.replies[0].record.notes).toBeUndefined();

        const call = vi.mocked(replyService.searchReplies).mock.calls[0];
        expect(call[0]).toBe('v3');
        expect(call[1]).toBe('hello');
        expect(call[2]).toMatchObject({
            promptId: 'p-x',
            status: 'archived',
            readStatus: 'unread',
        });
        expect(call[2]?.dateFrom).toBeInstanceOf(Date);
        expect(call[2]?.dateTo).toBeInstanceOf(Date);
    });

    it('applies defaults when optional filters are omitted', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v4' });
        vi.mocked(replyService.searchReplies).mockResolvedValue([]);

        await app().request('/api/v1/replies/search?q=howdy', {
            headers: { authorization: 'Bearer ok' },
        });

        const filters = vi.mocked(replyService.searchReplies).mock.calls[0][2];
        expect(filters?.status).toBe('live');
        expect(filters?.readStatus).toBe('all');
        expect(filters?.promptId).toBeUndefined();
        expect(filters?.dateFrom).toBeUndefined();
        expect(filters?.dateTo).toBeUndefined();
    });

    it('maps service errors to 500', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v5' });
        vi.mocked(replyService.searchReplies).mockRejectedValue(new Error('index missing'));

        const res = await app().request('/api/v1/replies/search?q=oops', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(500);
    });
});
