import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `POST /api/v1/users/switch-org` + `POST /api/v1/users/badges/read`.
 *
 * Mocks `organizationService`, Firebase Auth, and Firestore. The switch-org
 * endpoint leans heavily on the Auth mock for getUser / setCustomUserClaims;
 * badges/read leans on Firestore for the user-doc update.
 */

const setCustomUserClaims = vi.fn();
const getUserAuth = vi.fn();
const userDocUpdate = vi.fn();

vi.mock('../services/core-services-firebase.js', () => ({
    organizationService: {
        getMemberRole: vi.fn(),
        getUserOrganizations: vi.fn(),
    },
    userService: {},
    promptService: {},
    replyService: {},
    feedService: {},
    firebaseCoreServices: {},
}));

vi.mock('../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (_name: string) => ({
            doc: (_id: string) => ({
                update: (patch: unknown) => userDocUpdate(patch),
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
    getAdminAuth: () => ({
        getUser: (uid: string) => getUserAuth(uid),
        setCustomUserClaims: (uid: string, claims: unknown) => setCustomUserClaims(uid, claims),
    }),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../app.js');
const { organizationService } = await import('../services/core-services-firebase.js');
const { sessionVerifier } = await import('../lib/auth/session-verifier.js');

const bearerPost = (path: string, body: unknown) =>
    app().request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
        body: JSON.stringify(body),
    });

describe('POST /api/v1/users/switch-org', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        setCustomUserClaims.mockReset();
        getUserAuth.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/switch-org', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ orgId: 'org-1' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s when orgId is missing from body', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await bearerPost('/api/v1/users/switch-org', {});
        expect(res.status).toBe(400);
    });

    it('403s when viewer is not a member of the target org', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-out' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue(null);

        const res = await bearerPost('/api/v1/users/switch-org', { orgId: 'org-no' });

        expect(res.status).toBe(403);
        expect(setCustomUserClaims).not.toHaveBeenCalled();
    });

    it('switches to an org and writes full claim map', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-in' });
        vi.mocked(organizationService.getMemberRole).mockResolvedValue('admin');
        vi.mocked(organizationService.getUserOrganizations).mockResolvedValue([
            { record: { id: 'org-a' }, currentUserRole: 'admin' },
            { record: { id: 'org-b' }, currentUserRole: 'member' },
            // Ignored: no currentUserRole.
            { record: { id: 'org-c' } },
        ] as unknown as Awaited<ReturnType<typeof organizationService.getUserOrganizations>>);
        getUserAuth.mockResolvedValue({ customClaims: { admin: true } });
        setCustomUserClaims.mockResolvedValue(undefined);

        const res = await bearerPost('/api/v1/users/switch-org', { orgId: 'org-a' });

        expect(res.status).toBe(200);
        expect(setCustomUserClaims).toHaveBeenCalledWith('u-in', {
            admin: true,
            currentOrg: 'org-a',
            orgs: { 'org-a': 'admin', 'org-b': 'member' },
        });
        const body = await res.json();
        expect(body).toEqual({
            success: true,
            data: { currentOrg: 'org-a', orgs: { 'org-a': 'admin', 'org-b': 'member' } },
        });
    });

    it('switches to personal (orgId=null) without membership check', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-solo' });
        vi.mocked(organizationService.getUserOrganizations).mockResolvedValue([]);
        getUserAuth.mockResolvedValue({ customClaims: {} });
        setCustomUserClaims.mockResolvedValue(undefined);

        const res = await bearerPost('/api/v1/users/switch-org', { orgId: null });

        expect(res.status).toBe(200);
        expect(organizationService.getMemberRole).not.toHaveBeenCalled();
        expect(setCustomUserClaims).toHaveBeenCalledWith('u-solo', {
            currentOrg: null,
            orgs: {},
        });
    });
});

describe('POST /api/v1/users/badges/read', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        userDocUpdate.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/badges/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'new_replier' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid type', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await bearerPost('/api/v1/users/badges/read', { type: 'invalid' });
        expect(res.status).toBe(400);
    });

    it('resets new_replier counter', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await bearerPost('/api/v1/users/badges/read', { type: 'new_replier' });

        expect(res.status).toBe(200);
        expect(userDocUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ newReplierCount: 0, lastSeenAt: expect.anything() }),
        );
    });

    it('resets unread_reply counter', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-2' });
        const res = await bearerPost('/api/v1/users/badges/read', { type: 'unread_reply' });

        expect(res.status).toBe(200);
        expect(userDocUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ unreadReplyCount: 0, lastSeenAt: expect.anything() }),
        );
    });
});
