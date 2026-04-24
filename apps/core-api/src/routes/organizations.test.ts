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
        createOrganization: vi.fn(),
        getOrganizationBySlug: vi.fn(),
        updateOrganization: vi.fn(),
        createInvite: vi.fn(),
        acceptInvite: vi.fn(),
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
    },
    hydrationService: {
        hydrateOrganization: vi.fn(),
        hydrateInvite: vi.fn(),
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

const handleDocGet = vi.fn();

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (name: string) => ({
            doc: (id: string) => ({
                get: () => handleDocGet(name, id),
            }),
        }),
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
const { organizationService, promptService, hydrationService } = await import(
    '../services/core-services-firebase.js'
);
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

const jsonReq = (body: unknown, method: string) => ({
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
    body: JSON.stringify(body),
});

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

describe('POST /api/v1/organizations', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        handleDocGet.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Alpha', slug: 'alpha' }),
        });
        expect(res.status).toBe(401);
    });

    it('409s when slug collides with an existing org', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue({
            record: { id: 'org-existing' },
        } as unknown as Awaited<ReturnType<typeof organizationService.getOrganizationBySlug>>);
        handleDocGet.mockResolvedValue({ exists: false });

        const res = await app().request(
            '/api/v1/organizations',
            jsonReq({ name: 'Alpha', slug: 'alpha' }, 'POST'),
        );
        expect(res.status).toBe(409);
    });

    it('409s when slug collides with a user handle', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(null);
        handleDocGet.mockResolvedValue({ exists: true });

        const res = await app().request(
            '/api/v1/organizations',
            jsonReq({ name: 'Alpha', slug: 'alpha' }, 'POST'),
        );
        expect(res.status).toBe(409);
    });

    it('creates when slug is free and returns the hydrated view', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-owner' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(null);
        handleDocGet.mockResolvedValue({ exists: false });
        vi.mocked(organizationService.createOrganization).mockResolvedValue({
            id: 'org-new',
            name: 'Alpha',
            slug: 'alpha',
        } as unknown as Awaited<ReturnType<typeof organizationService.createOrganization>>);
        vi.mocked(hydrationService.hydrateOrganization).mockResolvedValue({
            record: { id: 'org-new' },
            memberCount: 1,
            currentUserRole: 'owner',
        } as unknown as Awaited<ReturnType<typeof hydrationService.hydrateOrganization>>);

        const res = await app().request(
            '/api/v1/organizations',
            jsonReq({ name: 'Alpha org', slug: 'alpha-org' }, 'POST'),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('org-new');
    });
});

describe('PATCH /api/v1/organizations/:orgId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'New' }),
        });
        expect(res.status).toBe(401);
    });

    it('updates when caller is admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'admin' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('admin');
        vi.mocked(organizationService.updateOrganization).mockResolvedValue({
            id: 'org-1',
            name: 'New',
        } as unknown as Awaited<ReturnType<typeof organizationService.updateOrganization>>);

        const res = await app().request(
            '/api/v1/organizations/org-1',
            jsonReq({ name: 'New' }, 'PATCH'),
        );
        expect(res.status).toBe(200);
    });
});

describe('Org invites + member writes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('POST /invites creates an invite for admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'admin' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('admin');
        vi.mocked(organizationService.createInvite).mockResolvedValue({
            id: 'inv-1',
            orgId: 'org-1',
            email: 'x@y.com',
            role: 'member',
            invitedBy: 'admin',
            status: 'pending',
        } as unknown as Awaited<ReturnType<typeof organizationService.createInvite>>);
        vi.mocked(hydrationService.hydrateInvite).mockResolvedValue({
            record: { id: 'inv-1' },
        } as unknown as Awaited<ReturnType<typeof hydrationService.hydrateInvite>>);

        const res = await app().request(
            '/api/v1/organizations/org-1/invites',
            jsonReq({ email: 'x@y.com', role: 'member' }, 'POST'),
        );
        expect(res.status).toBe(200);
    });

    it('POST /invites/:id accepts an invite for any authenticated user', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'joiner' });
        vi.mocked(organizationService.acceptInvite).mockResolvedValue({
            orgId: 'org-1',
            userId: 'joiner',
            role: 'member',
        } as unknown as Awaited<ReturnType<typeof organizationService.acceptInvite>>);

        const res = await app().request('/api/v1/organizations/org-1/invites/inv-1', {
            method: 'POST',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(200);
    });

    it('PATCH /members/:userId updates a role for admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'admin' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('admin');
        vi.mocked(organizationService.updateMemberRole).mockResolvedValue(undefined);

        const res = await app().request(
            '/api/v1/organizations/org-1/members/u-target',
            jsonReq({ role: 'admin' }, 'PATCH'),
        );
        expect(res.status).toBe(200);
    });

    it('DELETE /members/:userId allows self-leave without admin role', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('member');
        vi.mocked(organizationService.removeMember).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/organizations/org-1/members/u-self', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(200);
    });

    it('DELETE /members/:userId requires admin when removing someone else', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'admin' });
        vi.mocked(organizationService.assertOrgRole).mockResolvedValue('admin');
        vi.mocked(organizationService.removeMember).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/organizations/org-1/members/u-target', {
            method: 'DELETE',
            headers: { authorization: 'Bearer ok' },
        });
        expect(res.status).toBe(200);
        // Verify the admin role was asserted (not the broader member role).
        expect(
            vi.mocked(organizationService.assertOrgRole).mock.calls[0][2],
        ).toEqual(['owner', 'admin']);
    });
});
