import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `GET /api/v1/organizations/slug/:slug`.
 */

vi.mock('../services/core-services-firebase.js', () => ({
    organizationService: {
        getOrganizationBySlug: vi.fn(),
    },
    userService: {},
    promptService: {},
    hydrationService: {},
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
const { organizationService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

type MockOrgView = ReturnType<typeof mkOrg>;

function mkOrg(overrides: Record<string, unknown> = {}) {
    return {
        record: {
            id: 'org-1',
            name: 'Acme Inc',
            slug: 'acme',
            ownerId: 'owner-1',
            createdAt: new Date().toISOString(),
        },
        memberCount: 7,
        currentUserRole: undefined,
        ...overrides,
    };
}

function asOrgView(v: MockOrgView) {
    return v as unknown as Awaited<ReturnType<typeof organizationService.getOrganizationBySlug>>;
}

describe('GET /api/v1/organizations/slug/:slug', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the hydrated org view', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(asOrgView(mkOrg()));

        const res = await app().request('/api/v1/organizations/slug/acme');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.record.slug).toBe('acme');
        expect(body.data.memberCount).toBe(7);
    });

    it('passes viewerUid=undefined to the service when anonymous', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(asOrgView(mkOrg()));

        await app().request('/api/v1/organizations/slug/alpha');

        expect(organizationService.getOrganizationBySlug).toHaveBeenCalledWith('alpha', undefined);
    });

    it('forwards the viewer uid when a bearer token is present', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-viewer' });
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(asOrgView(mkOrg()));

        await app().request('/api/v1/organizations/slug/beta', {
            headers: { authorization: 'Bearer token-v1' },
        });

        expect(organizationService.getOrganizationBySlug).toHaveBeenCalledWith('beta', 'u-viewer');
    });

    it('returns 404 when the slug does not match any org', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(null);

        const res = await app().request('/api/v1/organizations/slug/missing');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ success: false, error: 'Organization not found' });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockResolvedValue(
            asOrgView(mkOrg({ record: { id: 'o-h', slug: 'hdr', name: 'Hdr', ownerId: 'o', createdAt: '' } })),
        );

        const res = await app().request('/api/v1/organizations/slug/hdr', {
            headers: { 'x-request-id': 'trace-org' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-org');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(organizationService.getOrganizationBySlug).mockRejectedValue(new Error('firestore down'));

        const res = await app().request('/api/v1/organizations/slug/boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.status).toBe('error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
