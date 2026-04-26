import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/people/list`.
 *
 * Auth-gated (requireAuth). Delegates to `feedService.getPeopleList`
 * which returns `EnrichedReplier[]` — the dashboard CRM "People" view.
 * Optional `orgId` query param scopes to an org context.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    feedService: { getPeopleList: vi.fn() },
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

describe('GET /api/v1/people/list', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/people/list');
        expect(res.status).toBe(401);
    });

    it('returns enriched repliers for the authenticated viewer (personal context)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pl1' });
        const fakeReplier = {
            id: 'replier-1',
            handle: 'someone',
            displayName: 'Someone',
            replyCount: 3,
            firstReplyAt: '2025-01-01T00:00:00.000Z',
            lastReplyAt: '2025-02-01T00:00:00.000Z',
            phoneNumber: null,
        };
        vi.mocked(feedService.getPeopleList).mockResolvedValue([
            fakeReplier,
        ] as unknown as Awaited<ReturnType<typeof feedService.getPeopleList>>);

        const res = await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: [fakeReplier] });
        // Personal context: orgId omitted from query → null forwarded.
        expect(vi.mocked(feedService.getPeopleList)).toHaveBeenCalledWith('viewer-pl1', null);
    });

    it('forwards orgId when present in the query', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pl2' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list?orgId=acme-co', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(vi.mocked(feedService.getPeopleList)).toHaveBeenCalledWith('viewer-pl2', 'acme-co');
    });

    it('treats empty-string orgId as personal context (null)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pl3' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list?orgId=', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(vi.mocked(feedService.getPeopleList)).toHaveBeenCalledWith('viewer-pl3', null);
    });

    it('returns empty array when service yields no repliers', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pl4' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        const res = await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: [] });
    });

    it('maps service errors to 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pl5' });
        vi.mocked(feedService.getPeopleList).mockRejectedValue(new Error('boom'));

        const res = await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(500);
        expect((await res.json()).requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
