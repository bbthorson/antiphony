import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/people/list`. Parity for serverProxy
 * `feeds.getPeopleList`.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {
        getPeopleList: vi.fn(),
    },
    userService: {},
    organizationService: {},
    promptService: {},
    hydrationService: {},
    replyService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { feedService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

function mkReplier(id: string) {
    return {
        id,
        handle: `${id}-handle`,
        totalReplies: 1,
        firstReplyDate: new Date().toISOString(),
        lastReplyDate: new Date().toISOString(),
    } as unknown as Awaited<ReturnType<typeof feedService.getPeopleList>>[number];
}

describe('GET /api/v1/people/list', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the enriched-replier list for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([mkReplier('r-1'), mkReplier('r-2')]);

        const res = await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(2);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/people/list');
        expect(res.status).toBe(401);
    });

    it('passes orgId through to the service when set', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list?orgId=org-1', {
            headers: { authorization: 'Bearer t' },
        });

        expect(feedService.getPeopleList).toHaveBeenCalledWith('u-self', 'org-1');
    });

    it('treats missing orgId as null (personal context)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer t' },
        });

        expect(feedService.getPeopleList).toHaveBeenCalledWith('u-self', null);
    });

    it('treats empty-string orgId as null (personal context)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list?orgId=', {
            headers: { authorization: 'Bearer t' },
        });

        expect(feedService.getPeopleList).toHaveBeenCalledWith('u-self', null);
    });
});
