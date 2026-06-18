import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReplyView } from 'shared/types/views';

/**
 * Tests for `/api/v1/people/*` — the People (CRM) routes:
 *
 *   GET /                — full composite (repliers + enrichedRepliers + promptsWithReplies)
 *   GET /list            — just enrichedRepliers (lighter)
 *
 * Both are auth-required. (A person's activity timeline moved to the
 * cross-prompt reply feed, `GET /api/v1/replies/feed?authorUid=`.)
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {
        getPeopleData: vi.fn(),
        getPeopleList: vi.fn(),
    },
    userService: {},
    organizationService: {
        getMemberRole: vi.fn(),
    },
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
const { feedService, organizationService } = await import('../../outbound/firebase/core-services-firebase.js');
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

    it('passes orgId through to the service when the caller is a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list?orgId=org-1', {
            headers: { authorization: 'Bearer t' },
        });

        expect(organizationService.getMemberRole).toHaveBeenCalledWith('org-1', 'u-self');
        expect(feedService.getPeopleList).toHaveBeenCalledWith('u-self', 'org-1');
    });

    it('403s on orgId when the caller is NOT a member (IDOR guard)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue(null);
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        const res = await app().request('/api/v1/people/list?orgId=someone-elses-org', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(403);
        // The service — which would expose cross-org replier phone numbers —
        // must never run for a non-member.
        expect(feedService.getPeopleList).not.toHaveBeenCalled();
    });

    it('400s on a malformed orgId before touching the service', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });

        const res = await app().request(`/api/v1/people/list?orgId=${encodeURIComponent('a/../../fcm')}`, {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(400);
        expect(organizationService.getMemberRole).not.toHaveBeenCalled();
        expect(feedService.getPeopleList).not.toHaveBeenCalled();
    });

    it('does not check membership in personal context (no orgId)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleList).mockResolvedValue([]);

        await app().request('/api/v1/people/list', {
            headers: { authorization: 'Bearer t' },
        });

        expect(organizationService.getMemberRole).not.toHaveBeenCalled();
        expect(feedService.getPeopleList).toHaveBeenCalledWith('u-self', null);
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

// ---------------------------------------------------------------------------
// GET /api/v1/people — full composite
// ---------------------------------------------------------------------------

function mkReplyView(id: string, promptId: string, handle: string): ReplyView {
    return {
        record: {
            id,
            promptId,
            authorId: `u-${handle}`,
            audioUrl: `https://example.com/${id}.webm`,
            status: 'live' as const,
            createdAt: '2026-05-19T00:00:00Z',
            readBy: [],
        },
        author: { id: `u-${handle}`, handle, displayName: handle },
        recipient: { id: 'u-self', handle: 'self', displayName: 'Self' },
        // Private fields that MUST be stripped by toReplyViewPublic before
        // hitting the wire — the test asserts on their absence below.
        notes: 'private CRM note',
        listenerPhoneNumber: '+15551234567',
    } as unknown as ReplyView;
}

describe('GET /api/v1/people', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the full composite for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleData).mockResolvedValue({
            user: { id: 'u-self', handle: 'self', displayName: 'Self' },
            repliers: [mkReplier('r-1')],
            enrichedRepliers: [mkReplier('r-1')],
            promptsWithReplies: [
                {
                    prompt: { record: { id: 'p-1', title: 'P1' } },
                    replies: [mkReplyView('r-1', 'p-1', 'replier_handle')],
                },
            ],
        } as never);

        const res = await app().request('/api/v1/people', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.repliers).toHaveLength(1);
        expect(body.data.enrichedRepliers).toHaveLength(1);
        expect(body.data.promptsWithReplies).toHaveLength(1);
        expect(feedService.getPeopleData).toHaveBeenCalledWith('u-self');
    });

    it('strips private fields from reply objects in promptsWithReplies', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleData).mockResolvedValue({
            user: { id: 'u-self', handle: 'self', displayName: 'Self' },
            repliers: [],
            enrichedRepliers: [],
            promptsWithReplies: [
                {
                    prompt: { record: { id: 'p-1', title: 'P1' } },
                    replies: [mkReplyView('r-1', 'p-1', 'replier')],
                },
            ],
        } as never);

        const res = await app().request('/api/v1/people', {
            headers: { authorization: 'Bearer t' },
        });

        const body = await res.json();
        const reply = body.data.promptsWithReplies[0].replies[0];
        expect(reply.notes).toBeUndefined();
        expect(reply.listenerPhoneNumber).toBeUndefined();
        // But the public reply shape must still be intact.
        expect(reply.record.id).toBe('r-1');
        expect(reply.author.handle).toBe('replier');
    });

    it('returns 404 when getPeopleData returns null', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPeopleData).mockResolvedValue(null as never);

        const res = await app().request('/api/v1/people', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(404);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/people');
        expect(res.status).toBe(401);
    });
});
