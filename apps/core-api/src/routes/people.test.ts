import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the top-level people endpoints in `people.ts`:
 *   - GET /api/v1/people (full CRM dashboard data)
 *   - GET /api/v1/people/:handle/notes (per-viewer notes/tags)
 *
 * Both auth-gated; /:handle/notes uses inline Firestore (matches apps/web's
 * pattern for per-user CRM data).
 */

const fakeNotesDoc: { exists: boolean; data: () => unknown } = {
    exists: false,
    data: () => undefined,
};

vi.mock('../services/core-services-firebase.js', () => ({
    feedService: { getPeopleData: vi.fn() },
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
        collection: (name: string) => {
            if (name === 'users') {
                return {
                    doc: () => ({
                        // For the per-user CRM read.
                        collection: () => ({
                            doc: () => ({
                                get: async () => fakeNotesDoc,
                            }),
                        }),
                    }),
                };
            }
            // Generic fallback for the rate-limit middleware.
            return { doc: () => ({}) };
        },
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

describe('GET /api/v1/people', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/people');
        expect(res.status).toBe(401);
    });

    it('returns 404 when feedService yields no data', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pp1' });
        vi.mocked(feedService.getPeopleData).mockResolvedValue(null);

        const res = await app().request('/api/v1/people', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(404);
    });

    it('returns dashboard data with replies projected through toReplyViewPublic', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pp2' });
        const fakePromptWithReplies = {
            record: { id: 'p-1', title: 'Hello' },
            replies: [
                {
                    record: {
                        id: 'r-1',
                        promptId: 'p-1',
                        authorId: 'them',
                        createdAt: new Date().toISOString(),
                        status: 'live',
                        audioUrl: 'https://x',
                        notes: 'private',
                    },
                    author: { id: 'them' },
                    recipient: { id: 'viewer-pp2' },
                    isRead: true,
                    isDeleted: false,
                    isVerified: false,
                    readBy: [],
                    authorRating: 5,
                    listenerPhoneNumber: '+15555550001',
                },
            ],
        };
        vi.mocked(feedService.getPeopleData).mockResolvedValue({
            repliers: [{ id: 'them', handle: 'them' }],
            enrichedRepliers: [{ id: 'them', replyCount: 1 }],
            promptsWithReplies: [fakePromptWithReplies],
        } as unknown as Awaited<ReturnType<typeof feedService.getPeopleData>>);

        const res = await app().request('/api/v1/people', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.repliers).toHaveLength(1);
        expect(body.enrichedRepliers).toHaveLength(1);
        expect(body.promptsWithReplies).toHaveLength(1);
        // Public projection strips CRM-only fields.
        expect(body.promptsWithReplies[0].replies[0].authorRating).toBeUndefined();
        expect(body.promptsWithReplies[0].replies[0].listenerPhoneNumber).toBeUndefined();
        expect(body.promptsWithReplies[0].replies[0].record.notes).toBeUndefined();
    });
});

describe('GET /api/v1/people/:handle/notes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        fakeNotesDoc.exists = false;
        fakeNotesDoc.data = () => undefined;
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/people/somehandle/notes');
        expect(res.status).toBe(401);
    });

    it('returns empty notes/tags when no CRM doc exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pn1' });

        const res = await app().request('/api/v1/people/never-noted/notes', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ notes: '', tags: [] });
    });

    it('returns stored notes + tags when the CRM doc exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-pn2' });
        fakeNotesDoc.exists = true;
        fakeNotesDoc.data = () => ({ notes: 'great voice', tags: ['favorite', 'recurring'] });

        const res = await app().request('/api/v1/people/known-person/notes', {
            headers: { authorization: 'Bearer ok' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            notes: 'great voice',
            tags: ['favorite', 'recurring'],
        });
    });
});
