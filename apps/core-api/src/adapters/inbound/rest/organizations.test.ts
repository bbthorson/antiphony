import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the organization read endpoints mounted at `/api/v1/organizations`.
 * Covers parity with these serverProxy methods (Phase 4 strangler completion):
 *   - organizations.getOrganization
 *   - organizations.getOrganizationBySlug
 *   - organizations.getMembers
 *   - prompts.getPromptsForOrgContext (mounted under /:orgId/prompts)
 *   - feeds.getCachedOrgProfileData (mounted under /slug/:slug/profile)
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    organizationService: {
        getOrganization: vi.fn(),
        getOrganizationBySlug: vi.fn(),
        getMemberRole: vi.fn(),
        isMember: vi.fn(),
        getMembers: vi.fn(),
        // Writes (PR-A):
        createOrganization: vi.fn(),
        updateOrganization: vi.fn(),
        addMember: vi.fn(),
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
        createInvite: vi.fn(),
        acceptInvite: vi.fn(),
    },
    promptService: {
        getPromptsForOrgContext: vi.fn(),
    },
    feedService: {
        getOrgProfileData: vi.fn(),
    },
    hydrationService: {
        hydrateOrganization: vi.fn(),
        hydrateInvite: vi.fn(),
    },
    userService: {},
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
const { organizationService, promptService, feedService, hydrationService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

const jsonInit = (body: unknown, extra: Record<string, string> = {}) => ({
    method: 'POST' as const,
    headers: {
        'content-type': 'application/json',
        authorization: 'Bearer t',
        ...extra,
    },
    body: JSON.stringify(body),
});
const patchInit = (body: unknown) => ({ ...jsonInit(body), method: 'PATCH' as const });
const deleteInit = () => ({ method: 'DELETE' as const, headers: { authorization: 'Bearer t' } });

// Loose-typed view fixtures — minimal shape, cast at the seam.
function mkOrgView(id: string, slug = 'acme') {
    return {
        record: {
            id,
            slug,
            ownerId: 'u-owner',
            name: 'Acme',
            createdAt: new Date().toISOString(),
        },
        // currentUserRole hydrated by service
    } as unknown as Awaited<ReturnType<typeof organizationService.getOrganization>>;
}

function mkMemberView(userId: string, role: 'owner' | 'admin' | 'member' = 'member') {
    return {
        userId,
        role,
        joinedAt: new Date().toISOString(),
        user: { id: userId, handle: `${userId}-handle` },
    } as unknown as Awaited<ReturnType<typeof organizationService.getMembers>>[number];
}

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
    } as unknown as Awaited<ReturnType<typeof promptService.getPromptsForOrgContext>>[number];
}

describe('GET /api/v1/organizations/:orgId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the org when the viewer is a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        vi.mocked(organizationService.getOrganization).mockResolvedValue(mkOrgView('org-1'));

        const res = await app().request('/api/v1/organizations/org-1', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('org-1');
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/organizations/org-1');
        expect(res.status).toBe(401);
    });

    it('403s when the viewer is not a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-stranger' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/org-1', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(403);
    });

    it('404s when the org does not exist (but viewer is somehow a member)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        vi.mocked(organizationService.getOrganization).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/org-gone', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(404);
    });
});

describe('GET /api/v1/organizations/slug/:slug', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the org for an anonymous caller (auth optional)', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(mkOrgView('org-1', 'acme'));

        const res = await app().request('/api/v1/organizations/slug/acme');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.record.slug).toBe('acme');
    });

    it('forwards currentUserId from the auth context when present', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-viewer' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(mkOrgView('org-1', 'acme'));

        await app().request('/api/v1/organizations/slug/acme', {
            headers: { authorization: 'Bearer t' },
        });

        expect(organizationService.getOrganizationBySlug).toHaveBeenCalledWith('acme', 'u-viewer');
    });

    it('404s when the slug does not resolve', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(null);
        const res = await app().request('/api/v1/organizations/slug/ghost');
        expect(res.status).toBe(404);
    });
});

describe('GET /api/v1/organizations/slug/:slug/profile', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the aggregated profile payload (public, no auth)', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue({
            org: mkOrgView('org-1'),
            prompts: [],
            rssSummary: null,
        } as unknown as Awaited<ReturnType<typeof feedService.getOrgProfileData>>);

        const res = await app().request('/api/v1/organizations/slug/acme/profile');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.org.record.id).toBe('org-1');
    });

    it('404s when the slug does not resolve', async () => {
        vi.mocked(feedService.getOrgProfileData).mockResolvedValue(null);
        const res = await app().request('/api/v1/organizations/slug/ghost/profile');
        expect(res.status).toBe(404);
    });
});

describe('GET /api/v1/organizations/:orgId/members', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns members when the viewer is a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        vi.mocked(organizationService.getMembers).mockResolvedValue([mkMemberView('u-1', 'owner'), mkMemberView('u-2')]);

        const res = await app().request('/api/v1/organizations/org-1/members', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(2);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/organizations/org-1/members');
        expect(res.status).toBe(401);
    });

    it('403s when the viewer is not a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-stranger' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/org-1/members', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(403);
    });
});

describe('GET /api/v1/organizations/:orgId/prompts', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns prompts + nextCursor when the page is full', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        const items = [mkPromptView('p-a'), mkPromptView('p-b'), mkPromptView('p-c')];
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue(items);

        const res = await app().request('/api/v1/organizations/org-1/prompts?limit=3', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(3);
        expect(body.nextCursor).toBe('p-c');
    });

    it('returns nextCursor: null on an empty result', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue([]);

        const res = await app().request('/api/v1/organizations/org-1/prompts', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual([]);
        expect(body.nextCursor).toBeNull();
    });

    it('passes publicOnly through to the service when the query says so', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);
        vi.mocked(promptService.getPromptsForOrgContext).mockResolvedValue([]);

        await app().request('/api/v1/organizations/org-1/prompts?publicOnly=true&limit=10', {
            headers: { authorization: 'Bearer t' },
        });

        expect(promptService.getPromptsForOrgContext).toHaveBeenCalledWith('org-1', 10, undefined, true);
    });

    it('401s when no auth is provided', async () => {
        const res = await app().request('/api/v1/organizations/org-1/prompts');
        expect(res.status).toBe(401);
    });

    it('403s when the viewer is not a member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-stranger' });
        vi.mocked(organizationService.isMember).mockResolvedValue(false);

        const res = await app().request('/api/v1/organizations/org-1/prompts', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(403);
    });

    it('400s on out-of-range limit', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.isMember).mockResolvedValue(true);

        const res = await app().request('/api/v1/organizations/org-1/prompts?limit=9999', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(400);
    });
});

// ===========================================================================
// Writes (PR-A)
// ===========================================================================

describe('POST /api/v1/organizations', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    const validBody = {
        name: 'Acme Org',
        slug: 'acme-org',
        description: 'A test organization',
    };

    it('creates an org and returns the hydrated view (status owner)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-creator' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(null);
        vi.mocked(organizationService.createOrganization).mockResolvedValue({
            id: 'org-new',
            slug: 'acme-org',
            name: 'Acme Org',
            ownerId: 'u-creator',
            createdAt: new Date(),
            domainVerified: false,
            tier: 'business',
        } as unknown as Awaited<ReturnType<typeof organizationService.createOrganization>>);
        vi.mocked(hydrationService.hydrateOrganization).mockResolvedValue(
            mkOrgView('org-new', 'acme-org') as NonNullable<ReturnType<typeof mkOrgView>>,
        );

        const res = await app().request('/api/v1/organizations', jsonInit(validBody));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.id).toBe('org-new');
        expect(organizationService.createOrganization).toHaveBeenCalledWith('u-creator', validBody);
        expect(hydrationService.hydrateOrganization).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-new' }), 'owner');
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(401);
    });

    it('409 when slug is already taken', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-creator' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(mkOrgView('existing', 'acme-org'));

        const res = await app().request('/api/v1/organizations', jsonInit(validBody));

        expect(res.status).toBe(409);
        expect(organizationService.createOrganization).not.toHaveBeenCalled();
    });

    it('400 on invalid body (missing name)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-creator' });
        const res = await app().request('/api/v1/organizations', jsonInit({ slug: 'acme-org' }));
        expect(res.status).toBe(400);
    });
});

describe('PATCH /api/v1/organizations/:orgId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('updates the org when caller is admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.updateOrganization).mockResolvedValue({
            id: 'org-1',
            slug: 'acme-org',
            name: 'Acme Renamed',
            ownerId: 'u-owner',
            createdAt: new Date(),
            domainVerified: false,
            tier: 'business',
        } as unknown as Awaited<ReturnType<typeof organizationService.updateOrganization>>);
        vi.mocked(hydrationService.hydrateOrganization).mockResolvedValue(
            mkOrgView('org-1') as NonNullable<ReturnType<typeof mkOrgView>>,
        );

        const res = await app().request('/api/v1/organizations/org-1', patchInit({ name: 'Acme Renamed' }));

        expect(res.status).toBe(200);
        expect(organizationService.updateOrganization).toHaveBeenCalledWith('org-1', { name: 'Acme Renamed' });
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'X' }),
        });
        expect(res.status).toBe(401);
    });

    it('403 when caller is not admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');

        const res = await app().request('/api/v1/organizations/org-1', patchInit({ name: 'X' }));
        expect(res.status).toBe(403);
    });

    it('409 on slug rename collision', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(
            mkOrgView('other-org', 'taken-slug'),
        );

        const res = await app().request('/api/v1/organizations/org-1', patchInit({ slug: 'taken-slug' }));
        expect(res.status).toBe(409);
        expect(organizationService.updateOrganization).not.toHaveBeenCalled();
    });
});

describe('POST /api/v1/organizations/:orgId/members', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('adds a member when caller is admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.addMember).mockResolvedValue({
            orgId: 'org-1',
            userId: 'u-new',
            role: 'member',
            joinedAt: new Date(),
        } as unknown as Awaited<ReturnType<typeof organizationService.addMember>>);

        const res = await app().request(
            '/api/v1/organizations/org-1/members',
            jsonInit({ userId: 'u-new', role: 'member' }),
        );

        expect(res.status).toBe(200);
        expect(organizationService.addMember).toHaveBeenCalledWith('org-1', 'u-new', 'member', 'u-admin');
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/members', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'u-new', role: 'member' }),
        });
        expect(res.status).toBe(401);
    });

    it('403 when caller is not admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        const res = await app().request(
            '/api/v1/organizations/org-1/members',
            jsonInit({ userId: 'u-new', role: 'member' }),
        );
        expect(res.status).toBe(403);
    });

    it('400 on invalid role', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        const res = await app().request(
            '/api/v1/organizations/org-1/members',
            jsonInit({ userId: 'u-new', role: 'superuser' }),
        );
        expect(res.status).toBe(400);
    });
});

describe('PATCH /api/v1/organizations/:orgId/members/:userId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it("updates a member's role when caller is admin+", async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.updateMemberRole).mockResolvedValue(undefined);

        const res = await app().request(
            '/api/v1/organizations/org-1/members/u-target',
            patchInit({ role: 'admin' }),
        );

        expect(res.status).toBe(200);
        expect(organizationService.updateMemberRole).toHaveBeenCalledWith('org-1', 'u-target', 'admin');
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/members/u-target', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'admin' }),
        });
        expect(res.status).toBe(401);
    });

    it('403 when caller is not admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        const res = await app().request(
            '/api/v1/organizations/org-1/members/u-target',
            patchInit({ role: 'admin' }),
        );
        expect(res.status).toBe(403);
    });
});

describe('DELETE /api/v1/organizations/:orgId/members/:userId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('admin can remove another member', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.removeMember).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/organizations/org-1/members/u-target', deleteInit());

        expect(res.status).toBe(200);
        expect(organizationService.removeMember).toHaveBeenCalledWith('org-1', 'u-target');
    });

    it('plain member can remove themselves (self-leave)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-self' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');
        vi.mocked(organizationService.removeMember).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/organizations/org-1/members/u-self', deleteInit());

        expect(res.status).toBe(200);
        expect(organizationService.removeMember).toHaveBeenCalledWith('org-1', 'u-self');
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/members/u-target', {
            method: 'DELETE',
        });
        expect(res.status).toBe(401);
    });

    it('403 when plain member tries to remove someone else', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');

        const res = await app().request('/api/v1/organizations/org-1/members/u-other', deleteInit());
        expect(res.status).toBe(403);
    });

    it('403 when caller is not a member at all', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-stranger' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/org-1/members/u-target', deleteInit());
        expect(res.status).toBe(403);
    });
});

describe('POST /api/v1/organizations/:orgId/invites', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('admin creates an invite; response is hydrated view', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        const fakeRecord = {
            id: 'inv-1',
            orgId: 'org-1',
            email: 'newbie@example.com',
            role: 'member',
            invitedBy: 'u-admin',
            status: 'pending',
            createdAt: new Date(),
            expiresAt: new Date(),
        };
        const fakeView = { ...fakeRecord, inviterName: 'Admin Person', orgName: 'Acme' };
        vi.mocked(organizationService.createInvite).mockResolvedValue(
            fakeRecord as unknown as Awaited<ReturnType<typeof organizationService.createInvite>>,
        );
        vi.mocked(hydrationService.hydrateInvite).mockResolvedValue(
            fakeView as unknown as Awaited<ReturnType<typeof hydrationService.hydrateInvite>>,
        );

        const res = await app().request(
            '/api/v1/organizations/org-1/invites',
            jsonInit({ email: 'newbie@example.com', role: 'member' }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.id).toBe('inv-1');
        expect(organizationService.createInvite).toHaveBeenCalledWith('org-1', {
            email: 'newbie@example.com',
            role: 'member',
            invitedBy: 'u-admin',
        });
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/invites', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'x@y.com', role: 'member' }),
        });
        expect(res.status).toBe(401);
    });

    it('403 when caller is not admin+', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-member' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('member');

        const res = await app().request(
            '/api/v1/organizations/org-1/invites',
            jsonInit({ email: 'x@y.com', role: 'member' }),
        );
        expect(res.status).toBe(403);
    });

    it('400 on invalid email', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-admin' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');

        const res = await app().request(
            '/api/v1/organizations/org-1/invites',
            jsonInit({ email: 'not-an-email', role: 'member' }),
        );
        expect(res.status).toBe(400);
    });
});

describe('POST /api/v1/organizations/:orgId/invites/:inviteId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('accepts an invite and returns the member record', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-accepter' });
        vi.mocked(organizationService.acceptInvite).mockResolvedValue({
            orgId: 'org-1',
            userId: 'u-accepter',
            role: 'member',
            joinedAt: new Date(),
            invitedBy: 'u-admin',
        } as unknown as Awaited<ReturnType<typeof organizationService.acceptInvite>>);

        const res = await app().request('/api/v1/organizations/org-1/invites/inv-1', {
            method: 'POST',
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.userId).toBe('u-accepter');
        expect(organizationService.acceptInvite).toHaveBeenCalledWith('org-1', 'inv-1', 'u-accepter');
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/organizations/org-1/invites/inv-1', {
            method: 'POST',
        });
        expect(res.status).toBe(401);
    });
});
