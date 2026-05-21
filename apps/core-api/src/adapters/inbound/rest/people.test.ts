import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReplyView } from 'shared/types';

/**
 * Tests for `/api/v1/people/*` — the People (CRM) routes:
 *
 *   GET /                — full composite (repliers + enrichedRepliers + promptsWithReplies)
 *   GET /list            — just enrichedRepliers (lighter)
 *   GET /:handle/replies — replies from a specific person
 *
 * All three are auth-required and parity-ported from apps/web in PR-F2.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {
        getPeopleData: vi.fn(),
        getPeopleList: vi.fn(),
        getPersonReplies: vi.fn(),
    },
    userService: {},
    organizationService: {},
    promptService: {},
    hydrationService: {},
    replyService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/crm-notes-store.js', () => ({
    getCrmNotes: vi.fn(),
    setCrmNotes: vi.fn(),
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
const { getCrmNotes, setCrmNotes } = await import('../../../lib/crm-notes-store.js');

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
                    replies: [mkReplyView('r-1', 'p-1', 'replier-handle')],
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

// ---------------------------------------------------------------------------
// GET /api/v1/people/:handle/replies
// ---------------------------------------------------------------------------

describe('GET /api/v1/people/:handle/replies', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns replies + promptTitles for the given handle', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPersonReplies).mockResolvedValue({
            replies: [
                mkReplyView('r-1', 'p-1', 'replier-handle'),
                mkReplyView('r-2', 'p-2', 'replier-handle'),
            ],
            promptTitles: { 'p-1': 'First Prompt', 'p-2': 'Second Prompt' },
        } as never);

        const res = await app().request('/api/v1/people/replier-handle/replies', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.replies).toHaveLength(2);
        expect(body.data.promptTitles).toEqual({ 'p-1': 'First Prompt', 'p-2': 'Second Prompt' });
        expect(feedService.getPersonReplies).toHaveBeenCalledWith('u-self', 'replier-handle');
    });

    it('strips private fields from reply objects', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(feedService.getPersonReplies).mockResolvedValue({
            replies: [mkReplyView('r-1', 'p-1', 'replier-handle')],
            promptTitles: { 'p-1': 'P1' },
        } as never);

        const res = await app().request('/api/v1/people/replier-handle/replies', {
            headers: { authorization: 'Bearer t' },
        });

        const body = await res.json();
        expect(body.data.replies[0].notes).toBeUndefined();
        expect(body.data.replies[0].listenerPhoneNumber).toBeUndefined();
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/people/replier-handle/replies');
        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// GET /api/v1/people/:handle/notes
// ---------------------------------------------------------------------------

describe('GET /api/v1/people/:handle/notes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the viewer\'s notes for the target handle', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(getCrmNotes).mockResolvedValue({
            notes: 'Always asks great questions',
            tags: ['regular', 'verified'],
        });

        const res = await app().request('/api/v1/people/replier-handle/notes', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.notes).toBe('Always asks great questions');
        expect(body.data.tags).toEqual(['regular', 'verified']);
        expect(getCrmNotes).toHaveBeenCalledWith('u-self', 'replier-handle');
    });

    it('returns empty defaults when no notes exist', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(getCrmNotes).mockResolvedValue({ notes: '', tags: [] });

        const res = await app().request('/api/v1/people/no-notes/notes', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.notes).toBe('');
        expect(body.data.tags).toEqual([]);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/people/replier-handle/notes');
        expect(res.status).toBe(401);
        expect(getCrmNotes).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// POST /api/v1/people/:handle/notes
// ---------------------------------------------------------------------------

describe('POST /api/v1/people/:handle/notes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('writes notes + tags for the authenticated viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(setCrmNotes).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ notes: 'Got it', tags: ['vip'] }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(setCrmNotes).toHaveBeenCalledWith('u-self', 'replier-handle', {
            notes: 'Got it',
            tags: ['vip'],
        });
    });

    it('accepts partial updates (notes only)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(setCrmNotes).mockResolvedValue(undefined);

        await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ notes: 'Got it' }),
        });

        expect(setCrmNotes).toHaveBeenCalledWith('u-self', 'replier-handle', { notes: 'Got it' });
    });

    it('400s on invalid JSON body', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: 'not json',
        });
        expect(res.status).toBe(400);
        expect(setCrmNotes).not.toHaveBeenCalled();
    });

    it('400s when notes exceeds max length', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ notes: 'x'.repeat(10_001) }),
        });
        expect(res.status).toBe(400);
        expect(setCrmNotes).not.toHaveBeenCalled();
    });

    it('400s when tags is not a string array', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        const res = await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
            body: JSON.stringify({ tags: [1, 2, 3] }),
        });
        expect(res.status).toBe(400);
        expect(setCrmNotes).not.toHaveBeenCalled();
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/people/replier-handle/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ notes: 'x' }),
        });
        expect(res.status).toBe(401);
        expect(setCrmNotes).not.toHaveBeenCalled();
    });
});
