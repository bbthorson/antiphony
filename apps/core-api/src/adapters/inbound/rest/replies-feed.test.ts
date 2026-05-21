import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/replies/feed`.
 *
 * Auth-gated (requireAuth). No required query params (unlike /search's `q`);
 * filters (`promptId`, `status`, `readStatus`, `dateFrom`, `dateTo`) and
 * pagination (`limit`, `cursor`) are parsed from query string and forwarded
 * to `replyService.listReplyFeed`.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    replyService: { listReplyFeed: vi.fn() },
    userService: {},
    promptService: {},
    feedService: {},
    organizationService: {},
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
const { replyService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

describe('GET /api/v1/replies/feed', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/replies/feed');
        expect(res.status).toBe(401);
    });

    it('returns empty page + null cursor when service yields nothing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v0' });
        vi.mocked(replyService.listReplyFeed).mockResolvedValue({ replies: [], nextCursor: null });

        const res = await app().request('/api/v1/replies/feed', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: { items: [], nextCursor: null } });
    });

    it('forwards filters + pagination, returns public projection', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v1' });
        const fakeReply = {
            record: {
                id: 'r-x',
                promptId: 'p-x',
                authorId: 'them',
                createdAt: new Date('2026-04-15T12:00:00Z'),
                status: 'live',
                audioUrl: 'https://x',
            },
            author: { id: 'them' },
            recipient: { id: 'v1' },
            isRead: false,
            isDeleted: false,
            readBy: [],
            listenerPhoneNumber: '+15555554444',
            notes: 'secret',
        };
        vi.mocked(replyService.listReplyFeed).mockResolvedValue({
            replies: [fakeReply] as unknown as Awaited<ReturnType<typeof replyService.listReplyFeed>>['replies'],
            nextCursor: 'opaque-cursor-string',
        });

        const res = await app().request(
            '/api/v1/replies/feed?limit=50&cursor=abc&promptId=p-x&status=archived&readStatus=unread&dateFrom=2026-01-01&dateTo=2026-04-01',
            { headers: { authorization: 'Bearer ok' } },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.items).toHaveLength(1);
        // Public projection strips owner-only fields
        expect(body.data.items[0].listenerPhoneNumber).toBeUndefined();
        expect(body.data.items[0].notes).toBeUndefined();
        expect(body.data.nextCursor).toBe('opaque-cursor-string');

        const call = vi.mocked(replyService.listReplyFeed).mock.calls[0];
        expect(call[0]).toBe('v1');
        expect(call[1]).toMatchObject({
            promptId: 'p-x',
            status: 'archived',
            readStatus: 'unread',
        });
        expect(call[1]?.dateFrom).toBeInstanceOf(Date);
        expect(call[1]?.dateTo).toBeInstanceOf(Date);
        expect(call[2]).toEqual({ limit: 50, cursor: 'abc' });
    });

    it('applies defaults when optional params are omitted', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v2' });
        vi.mocked(replyService.listReplyFeed).mockResolvedValue({ replies: [], nextCursor: null });

        await app().request('/api/v1/replies/feed', {
            headers: { authorization: 'Bearer ok' },
        });

        const call = vi.mocked(replyService.listReplyFeed).mock.calls[0];
        expect(call[1]?.status).toBe('live');
        expect(call[1]?.readStatus).toBe('all');
        expect(call[1]?.promptId).toBeUndefined();
        expect(call[1]?.dateFrom).toBeUndefined();
        expect(call[1]?.dateTo).toBeUndefined();
        expect(call[2]?.limit).toBe(20);
        expect(call[2]?.cursor).toBeUndefined();
    });

    it('clamps oversized limit to 100', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v3' });
        vi.mocked(replyService.listReplyFeed).mockResolvedValue({ replies: [], nextCursor: null });

        await app().request('/api/v1/replies/feed?limit=999', {
            headers: { authorization: 'Bearer ok' },
        });

        const call = vi.mocked(replyService.listReplyFeed).mock.calls[0];
        expect(call[2]?.limit).toBe(100);
    });

    it('400s on non-numeric limit', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v4' });

        const res = await app().request('/api/v1/replies/feed?limit=abc', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.status).toBe('error');
    });

    it('400s on malformed dateFrom', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v5' });

        const res = await app().request('/api/v1/replies/feed?dateFrom=not-a-date', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(400);
    });

    it('maps service errors to 500', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'v6' });
        vi.mocked(replyService.listReplyFeed).mockRejectedValue(new Error('index missing'));

        const res = await app().request('/api/v1/replies/feed', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(500);
    });
});
