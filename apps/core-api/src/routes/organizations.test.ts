import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for auth-gated org reads mounted at `/api/v1/organizations`:
 *   GET /:orgId
 *   GET /:orgId/members
 *   GET /:orgId/prompts
 *
 * Uses `requireAuth()` plus membership checks via `organizationService`.
 * Mocks `organizationService` + `promptService` to isolate handler logic.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    organizationService: {
        assertOrgRole: vi.fn(),
        isMember: vi.fn(),
        getOrganization: vi.fn(),
        getMembers: vi.fn(),
    },
    promptService: {
        getPromptsForOrgContext: vi.fn(),
    },
    userService: {},
    replyService: {},
    feedService: {},
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
const { organizationService, promptService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

describe('GET /api/v1/organizations/:orgId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1');
        expect(res.status).toBe(401);
    });

    it('returns the hydrated org when the viewer is a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-1' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('member');
        const fakeOrg = {
            record: { id: 'org-1', name: 'Alpha', slug: 'alpha' },
            memberCount: 3,
            currentUserRole: 'member',
        };
        vi.mocked(organizationService.getOrganization).mockResolvedValue(
            fakeOrg as unknown as Awaited<ReturnType<typeof organizationService.getOrganization>>,
        );

        const res = await app().request('/api/v1/organizations/org-1', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: fakeOrg });
        expect(vi.mocked(organizationService.assertOrgRole)).toHaveBeenCalledWith(
            'org-1',
            'viewer-1',
            ['owner', 'admin', 'member'],
        );
    });

    it('404s when the org record is missing even though membership check passed', async () => {
        // Edge case: role doc exists but org doc was deleted. Author check
        // short-circuits past assertOrgRole (which only reads the role doc),
        // then getOrganization returns null.
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-2' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('member');
        vi.mocked(organizationService.getOrganization).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/org-missing', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('surfaces assertOrgRole insufficient-permissions as a 500 (parity with apps/web)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'non-member' });
        vi.mocked(organizationService.assertOrgRole).mockRejectedValue(
            new Error('Insufficient permissions'),
        );

        const res = await app().request('/api/v1/organizations/org-gate', {
            headers: { authorization: 'Bearer good' },
        });

        // Plain Error → 500 via the error-handler's "unknown" branch. Matches
        // apps/web's behavior. Tightening to 403 can happen when a shared
        // ForbiddenError lands across both tiers.
        expect(res.status).toBe(500);
    });
});

describe('GET /api/v1/organizations/:orgId/members', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/members');
        expect(res.status).toBe(401);
    });

    it('returns hydrated members for an allowed viewer', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-m' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('admin');
        const fakeMembers = [
            { record: { userId: 'u-1', role: 'owner' }, profile: { id: 'u-1', handle: 'alpha' } },
            { record: { userId: 'u-2', role: 'member' }, profile: { id: 'u-2', handle: 'beta' } },
        ];
        vi.mocked(organizationService.getMembers).mockResolvedValue(
            fakeMembers as unknown as Awaited<ReturnType<typeof organizationService.getMembers>>,
        );

        const res = await app().request('/api/v1/organizations/org-1/members', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: fakeMembers });
    });
});

describe('GET /api/v1/organizations/:orgId/prompts', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/prompts');
        expect(res.status).toBe(401);
    });

    it('403s when viewer is not a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'outsider' });
        vi.mocked(organizationService.isMember).mockResolvedValue(false);

        const res = await app().request('/api/v1/organizations/org-p/prompts', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toContain('Not a member');
    });

    it('returns prompts with a nextCursor when the page is full', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        const fakePrompts = Array.from({ length: 3 }, (_, i) => ({
            record: { id: `p-${i}`, authorId: 'a', title: `P ${i}`, status: 'live' },
            author: { id: 'a' },
            replyCount: 0,
            likeCount: 0,
            visibility: 'public',
        }));
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue(
            fakePrompts as unknown as Awaited<ReturnType<typeof promptService.getPromptsForOrgContext>>,
        );

        const res = await app().request('/api/v1/organizations/org-p/prompts?limit=3', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(3);
        expect(body.nextCursor).toBe('p-2');
    });

    it('returns nextCursor=null when the page is not full', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue([
            {
                record: { id: 'only-one', authorId: 'a', title: 'X', status: 'live' },
                author: { id: 'a' },
                replyCount: 0,
                likeCount: 0,
                visibility: 'public',
            },
        ] as unknown as Awaited<ReturnType<typeof promptService.getPromptsForOrgContext>>);

        const res = await app().request('/api/v1/organizations/org-p/prompts?limit=20', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.nextCursor).toBeNull();
    });

    it('400s on limit=0 (Zod rejects min(1))', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);

        const res = await app().request('/api/v1/organizations/org-p/prompts?limit=0', {
            headers: { authorization: 'Bearer good' },
        });

        expect(res.status).toBe(400);
    });

    it('publicOnly=true flows through to the service', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue([]);

        await app().request('/api/v1/organizations/org-p/prompts?publicOnly=true', {
            headers: { authorization: 'Bearer good' },
        });

        const call = vi.mocked(promptService.getPromptsForOrgContext).mock.calls[0];
        expect(call[3]).toBe(true);
    });
});
