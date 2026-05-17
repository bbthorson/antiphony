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

vi.mock('../services/core-services-firebase.js', () => ({
    organizationService: {
        getOrganization: vi.fn(),
        getOrganizationBySlug: vi.fn(),
        getMemberRole: vi.fn(),
        isMember: vi.fn(),
        getMembers: vi.fn(),
    },
    promptService: {
        getPromptsForOrgContext: vi.fn(),
    },
    feedService: {
        getOrgProfileData: vi.fn(),
    },
    userService: {},
    hydrationService: {},
    replyService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../app.js');
const { organizationService, promptService, feedService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

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
