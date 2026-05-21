import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/users/:handle/prompts`.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        getUserData: vi.fn(),
    },
    promptService: {
        getPromptsForUser: vi.fn(),
    },
    organizationService: {},
    hydrationService: {},
    feedService: {},
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
const { userService, promptService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

type MockPromptView = ReturnType<typeof mkPromptView>;

function mkPromptView(id: string) {
    return {
        record: {
            id,
            authorId: 'u-1',
            title: `Prompt ${id}`,
            status: 'live',
            createdAt: new Date().toISOString(),
            audioUrl: 'https://example.com/a.mp3',
        },
        author: { id: 'u-1', handle: 'alice' },
        replyCount: 0,
        lastReplyAt: null,
        likeCount: 0,
        visibility: 'public',
    };
}

// Satisfy vi.mocked's return types without threading full View types
// through every fixture.
function asPromptViews(views: MockPromptView[]) {
    return views as unknown as Awaited<ReturnType<typeof promptService.getPromptsForUser>>;
}

function asProfileView(profile: { id: string; handle: string }) {
    return profile as unknown as Awaited<ReturnType<typeof userService.getUserData>>;
}

describe('GET /api/v1/users/:handle/prompts', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the list + nextCursor when the page is full', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-1', handle: 'alice' }));
        const items = [mkPromptView('p-a'), mkPromptView('p-b'), mkPromptView('p-c')];
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews(items));

        // Caller asks for 3; service returns 3 → page is full, cursor present.
        const res = await app().request('/api/v1/users/alice/prompts?limit=3');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.items).toHaveLength(3);
        expect(body.data.nextCursor).toBe('p-c');
    });

    it('returns nextCursor: null when the page is not full', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-2', handle: 'bob' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([mkPromptView('p-x')]));

        const res = await app().request('/api/v1/users/bob/prompts?limit=20');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.items).toHaveLength(1);
        expect(body.data.nextCursor).toBeNull();
    });

    it('returns nextCursor: null on an empty result set', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-3', handle: 'carol' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([]));

        const res = await app().request('/api/v1/users/carol/prompts');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.items).toEqual([]);
        expect(body.data.nextCursor).toBeNull();
    });

    it('passes publicOnly=true for anonymous viewers (!isOwner)', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-4', handle: 'dave' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([]));

        await app().request('/api/v1/users/dave/prompts?limit=5');

        // Signature: (userId, limit, cursor, publicOnly)
        // Anonymous viewer → isOwner=false → publicOnly=true.
        expect(promptService.getPromptsForUser).toHaveBeenCalledWith('u-4', 5, undefined, true);
    });

    it('passes publicOnly=false when the viewer IS the target user', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-self', handle: 'self' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([]));

        await app().request('/api/v1/users/self/prompts?limit=5', {
            headers: { authorization: 'Bearer self-token' },
        });

        // Viewer is owner → publicOnly=false (returns live + archived).
        expect(promptService.getPromptsForUser).toHaveBeenCalledWith('u-self', 5, undefined, false);
    });

    it('passes publicOnly=true for authenticated-but-not-owner viewers', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'other-user' });
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-target', handle: 'target' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([]));

        await app().request('/api/v1/users/target/prompts?limit=5', {
            headers: { authorization: 'Bearer other-token' },
        });

        expect(promptService.getPromptsForUser).toHaveBeenCalledWith('u-target', 5, undefined, true);
    });

    it('returns 404 when the user does not exist', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/nobody/prompts');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'User not found' });
    });

    it('rejects invalid query params with 400', async () => {
        const res = await app().request('/api/v1/users/alice/prompts?limit=9999');

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toBe('Invalid query parameters');
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(asProfileView({ id: 'u-hdr', handle: 'alice' }));
        vi.mocked(promptService.getPromptsForUser).mockResolvedValue(asPromptViews([]));

        const res = await app().request('/api/v1/users/alice/prompts', {
            headers: { 'x-request-id': 'trace-qrs' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-qrs');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(userService.getUserData).mockRejectedValue(new Error('firestore outage'));

        const res = await app().request('/api/v1/users/alice/prompts');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
