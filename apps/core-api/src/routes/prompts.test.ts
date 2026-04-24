import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/prompts/:promptId`.
 *
 * Pre-bearer-bridge scope: `viewerUid = null` (anonymous viewer) — the
 * owner branch is dead code for now. These tests cover the anonymous
 * path: all successful responses go through `toPromptViewPublic`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    promptService: {
        getPromptData: vi.fn(),
    },
    userService: {},
    organizationService: {},
    hydrationService: {},
    feedService: {},
    firebaseCoreServices: {},
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
const { promptService } = await import('../services/core-services-firebase.js');

type MockPromptView = ReturnType<typeof mkPrompt>;

/**
 * Build a minimal PromptView shape. Includes owner-only fields
 * (analytics / moderation / aiSummary) so the stripping test can assert
 * they're gone in the public projection. Typed as `unknown` then cast
 * at the mock-resolve site to avoid `any` while keeping the fixture terse.
 */
function mkPrompt(overrides: { record?: Record<string, unknown>; visibility?: string } = {}) {
    return {
        record: {
            id: 'p-1',
            authorId: 'author-1',
            title: 'Hello',
            status: 'live',
            createdAt: new Date().toISOString(),
            audioUrl: 'https://example.com/a.mp3',
            ...overrides.record,
        },
        author: {
            id: 'author-1',
            handle: 'alice',
            displayName: 'Alice',
            email: 'leak@example.com', // only on full ProfileView; stripped in Basic
        },
        replyCount: 3,
        lastReplyAt: null,
        likeCount: 0,
        visibility: overrides.visibility ?? 'public',
        analytics: { listens: 42 }, // owner-only
        moderation: { flagged: false }, // owner-only
        aiSummary: 'owner-only summary', // owner-only
    };
}

// Helper: satisfy vi.mocked's return type without threading the full
// `PromptView` type through every fixture.
function asPromptView(v: MockPromptView) {
    return v as unknown as Awaited<ReturnType<typeof promptService.getPromptData>>;
}

describe('GET /api/v1/prompts/:promptId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the public projection (anonymous viewer — owner fields stripped)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt()));

        const res = await app().request('/api/v1/prompts/p-1');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('p-1');
        // Owner-only fields stripped.
        expect(body.data.analytics).toBeUndefined();
        expect(body.data.moderation).toBeUndefined();
        expect(body.data.aiSummary).toBeUndefined();
    });

    it('returns 404 when the prompt does not exist', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(null);

        const res = await app().request('/api/v1/prompts/missing');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'Prompt not found' });
    });

    it('returns 404 for non-live prompts (existence is hidden from non-owners)', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPromptView(mkPrompt({ record: { id: 'p-archive', authorId: 'a', status: 'archived' } })),
        );

        const res = await app().request('/api/v1/prompts/p-archive');

        expect(res.status).toBe(404);
    });

    it('returns 404 for private-visibility prompts to non-owners', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(
            asPromptView(mkPrompt({ visibility: 'private' })),
        );

        const res = await app().request('/api/v1/prompts/p-priv');

        expect(res.status).toBe(404);
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(promptService.getPromptData).mockResolvedValue(asPromptView(mkPrompt({ record: { id: 'p-hdr', authorId: 'a' } })));

        const res = await app().request('/api/v1/prompts/p-hdr', {
            headers: { 'x-request-id': 'trace-xyz' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-xyz');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(promptService.getPromptData).mockRejectedValue(new Error('firestore down'));

        const res = await app().request('/api/v1/prompts/p-boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
