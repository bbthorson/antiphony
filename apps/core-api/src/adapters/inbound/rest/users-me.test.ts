import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the authenticated-viewer `/api/v1/users/me` surface.
 *
 * Every route is `requireAuth()`-gated — anonymous request → 401, invalid
 * token → 401, valid token → pass through to the handler which echoes the
 * viewer's profile / claims / deactivation result.
 *
 * Mocks:
 *   - `sessionVerifier.verifyToken` — controls the auth outcome.
 *   - `core-services-firebase` — stubs `userService`.
 *   - `firebase-admin` — minimal mock so rate-limit middleware doesn't try
 *     to reach Firestore.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        getUserDataByUid: vi.fn(),
    },
    firebaseCoreServices: {},
}));

const updateUserProfileFn = vi.fn();
vi.mock('../../outbound/firebase/users-dependencies.js', () => ({
    firebaseUserDependencies: {
        updateUserProfile: (uid: string, updates: unknown) => updateUserProfileFn(uid, updates),
    },
}));

const userDocGet = vi.fn();
const txUserDocGet = vi.fn();
const txUpdate = vi.fn();
const txDelete = vi.fn();
const userDocUpdate = vi.fn();
const handleDocDelete = vi.fn();
const revokeRefreshTokens = vi.fn();

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

// Pre-transaction `db.collection(name).where(...).limit(...).get()` calls
// (e.g. the org-slug conflict check in POST /handle) resolve to empty
// by default. Tests that need to simulate a conflict can override
// `collectionWhereGet`.
const collectionWhereGet = vi.fn().mockResolvedValue({ empty: true, docs: [] });

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (name: string) => ({
            doc: (id: string) => ({
                __name: name,
                __id: id,
                get: () => userDocGet(name, id),
                update: (patch: unknown) => userDocUpdate(name, id, patch),
                delete: () => handleDocDelete(name, id),
            }),
            where: () => ({
                limit: () => ({
                    get: () => collectionWhereGet(name),
                }),
            }),
        }),
        runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
            fn({
                get: (ref: { __name: string; __id: string }) => txUserDocGet(ref.__name, ref.__id),
                set: () => undefined,
                update: (ref: { __name: string; __id: string }, patch: unknown) =>
                    txUpdate(ref.__name, ref.__id, patch),
                delete: (ref: { __name: string; __id: string }) =>
                    txDelete(ref.__name, ref.__id),
            }),
    }),
    getAdmin: () => ({
        firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } },
    }),
    getAdminAuth: () => ({
        revokeRefreshTokens: (uid: string) => revokeRefreshTokens(uid),
    }),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { userService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

function mkProfile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'viewer-uid',
        handle: 'viewer',
        displayName: 'Viewer',
        avatarUrl: 'https://example.com/v.jpg',
        bio: '',
        stats: { followers: 0, following: 0, prompts: 0 },
        badges: [],
        isVerified: false,
        createdAt: new Date().toISOString(),
        email: 'viewer@example.com',
        phoneNumber: '+15555550000',
        settings: { notifications: true },
        unreadReplyCount: 0,
        blockedUsers: [],
        reportCount: 0,
        isBanned: false,
        ...overrides,
    };
}

function asProfile(v: ReturnType<typeof mkProfile>) {
    return v as unknown as Awaited<ReturnType<typeof userService.getUserDataByUid>>;
}

describe('GET /api/v1/users/me', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s on missing Authorization header', async () => {
        const res = await app().request('/api/v1/users/me');
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Authentication required');
    });

    it('401s on invalid token', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockRejectedValue(new Error('bad token'));
        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer bogus' },
        });
        expect(res.status).toBe(401);
    });

    it('returns the full ProfileView (PII included) when authenticated', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(asProfile(mkProfile()));

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.handle).toBe('viewer');
        expect(body.data.email).toBe('viewer@example.com');
        expect(body.data.phoneNumber).toBe('+15555550000');
        expect(body.data.settings).toEqual({ notifications: true });
    });

    it('returns 404 if the profile does not exist for the viewer uid', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'orphan-uid' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token' },
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Profile not found');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-2' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(
            asProfile(mkProfile({ id: 'viewer-uid-2', handle: 'v2' })),
        );

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token-2', 'x-request-id': 'trace-me' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-me');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-uid-3' });
        vi.mocked(userService.getUserDataByUid).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/users/me', {
            headers: { authorization: 'Bearer good-token-3' },
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('PATCH /api/v1/users/me', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        updateUserProfileFn.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: 'New' }),
        });
        expect(res.status).toBe(401);
    });

    it('returns success with no changes when body is empty', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-p' });

        const res = await app().request('/api/v1/users/me', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: null });
        expect(updateUserProfileFn).not.toHaveBeenCalled();
    });

    it('updates when fields are provided', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-p' });
        updateUserProfileFn.mockResolvedValue(undefined);

        const res = await app().request('/api/v1/users/me', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({ displayName: 'New', bio: 'Hello' }),
        });

        expect(res.status).toBe(200);
        expect(updateUserProfileFn).toHaveBeenCalledWith('u-p', {
            displayName: 'New',
            bio: 'Hello',
        });
    });

    it('409s when handle is taken', async () => {
        const { ConflictError } = await import('shared/errors');
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-p' });
        updateUserProfileFn.mockRejectedValue(new ConflictError('Handle is already taken'));

        const res = await app().request('/api/v1/users/me', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({ handle: 'popular' }),
        });

        expect(res.status).toBe(409);
    });
});

describe('POST /api/v1/users/me/handle', () => {
    /**
     * Tests cover the three states the handler distinguishes plus the
     * handle-rename orphan-cleanup fix:
     *
     *   1. First claim — user doc has no prior handle. Old-handle delete
     *      should NOT fire (nothing to clean up).
     *   2. No-op re-claim — user's existing handle matches the request.
     *      Old-handle delete should NOT fire (would orphan the same doc
     *      it's preserving).
     *   3. Rename — user has handle "old", requests "new". Old-handle
     *      delete MUST fire; this is the bug the fix addresses
     *      (`memory/project_handle_rename_orphan_bug.md`).
     *   4. Handle already taken by someone else — 409.
     */

    // Stub the pre-transaction org-slug query — empty result means no conflict.
    // The handler reaches it via `db.collection('organizations').where(...).limit(1).get()`.
    // The default `vi.mock` for firebase-admin above sets collection().doc() but
    // not collection().where(); we override with a richer mock per test if needed.

    beforeEach(() => {
        vi.resetAllMocks();
        userDocGet.mockReset();
        txUserDocGet.mockReset();
        txUpdate.mockReset();
        txDelete.mockReset();
        userDocUpdate.mockReset();
        handleDocDelete.mockReset();
        // `vi.resetAllMocks` wipes `mockResolvedValue` defaults. Restore the
        // org-slug pre-check default → no conflict (empty result).
        collectionWhereGet.mockResolvedValue({ empty: true, docs: [] });
    });

    /** Common txUserDocGet wiring: returns the handle doc + user doc based on collection name. */
    function setupTxGets(args: {
        handleTaken?: boolean;
        handleOwner?: string;
        oldHandleOnUser?: string;
    }) {
        const { handleTaken = false, handleOwner, oldHandleOnUser } = args;
        txUserDocGet.mockImplementation((name: string) => {
            if (name === 'handles') {
                return Promise.resolve(
                    handleTaken
                        ? { exists: true, data: () => ({ uid: handleOwner }) }
                        : { exists: false, data: () => undefined },
                );
            }
            if (name === 'users') {
                return Promise.resolve({
                    data: () => (oldHandleOnUser ? { handle: oldHandleOnUser } : {}),
                });
            }
            return Promise.resolve({ exists: false, data: () => undefined });
        });
    }

    /** Mock the apps/core-api db so the pre-transaction `organizations.where().limit().get()` returns empty. */
    async function postHandle(body: unknown, token = 'ok'): Promise<Response> {
        // The default mock returned `db.collection(name).doc(id)` only; the
        // POST /handle pre-transaction also calls
        // `db.collection('organizations').where('slug', '==', x).limit(1).get()`.
        // That isn't part of the default mock, so the handler currently throws
        // when this code path is exercised. We patch it in via a one-shot
        // module override using vi.doMock just before the request — but that
        // requires re-importing the app. Simpler: rely on the existing mock
        // (collection().doc() works), and the org-slug check throws a
        // TypeError that's caught by the handler's outer try/catch as a
        // generic 500. That makes some assertions awkward.
        //
        // To keep the assertions clean, the test below uses vi.doMock to
        // extend the firebase-admin mock per-test.
        return app().request('/api/v1/users/me/handle', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
    }

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/handle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle: 'something' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid handle format', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-rename' });
        const res = await postHandle({ handle: 'a' }); // < min length
        expect(res.status).toBe(400);
    });

    it('rename: deletes the old handle doc and reserves the new (orphan-cleanup fix)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-rename' });
        setupTxGets({ handleTaken: false, oldHandleOnUser: 'oldname' });

        const res = await postHandle({ handle: 'newname' });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.handle).toBe('newname');
        // The fix: the orphan delete MUST fire on rename.
        expect(txDelete).toHaveBeenCalledWith('handles', 'oldname');
    });

    it('first claim: no old handle, no delete fires', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-first' });
        setupTxGets({ handleTaken: false /* oldHandleOnUser undefined */ });

        const res = await postHandle({ handle: 'newuser' });

        expect(res.status).toBe(200);
        expect(txDelete).not.toHaveBeenCalled();
    });

    it('no-op re-claim of viewer\'s own handle: no delete (would orphan the doc the handler preserves)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-same' });
        setupTxGets({
            handleTaken: true,
            handleOwner: 'u-same',
            oldHandleOnUser: 'samename',
        });

        const res = await postHandle({ handle: 'samename' });

        expect(res.status).toBe(200);
        expect(txDelete).not.toHaveBeenCalled();
    });

    it('409s when the handle is taken by another user', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-rejected' });
        setupTxGets({
            handleTaken: true,
            handleOwner: 'someone-else',
            oldHandleOnUser: 'whatever',
        });

        const res = await postHandle({ handle: 'taken' });

        expect(res.status).toBe(409);
        // Mustn't have deleted the old handle on the rejection path.
        expect(txDelete).not.toHaveBeenCalled();
    });
});

describe('POST /api/v1/users/me/delete', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        userDocGet.mockReset();
        txUserDocGet.mockReset();
        txUpdate.mockReset();
        txDelete.mockReset();
        userDocUpdate.mockReset();
        handleDocDelete.mockReset();
        revokeRefreshTokens.mockReset();
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
        });
        expect(res.status).toBe(401);
    });

    it('400s when confirm is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-d' });
        const res = await app().request('/api/v1/users/me/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('deactivates, releases handle, and revokes tokens (transactional)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-d' });
        txUserDocGet.mockResolvedValue({ data: () => ({ handle: 'mycoolhandle' }) });
        revokeRefreshTokens.mockResolvedValue(undefined);

        const res = await app().request('/api/v1/users/me/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({ confirm: true }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(txUpdate).toHaveBeenCalledWith(
            'users',
            'u-d',
            expect.objectContaining({ status: 'deactivated' }),
        );
        expect(txDelete).toHaveBeenCalledWith('handles', 'mycoolhandle');
        expect(revokeRefreshTokens).toHaveBeenCalledWith('u-d');
    });

    it('skips handle-release when the user has no handle set', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-lite' });
        txUserDocGet.mockResolvedValue({ data: () => ({}) });
        revokeRefreshTokens.mockResolvedValue(undefined);

        const res = await app().request('/api/v1/users/me/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
            body: JSON.stringify({ confirm: true }),
        });

        expect(res.status).toBe(200);
        expect(txDelete).not.toHaveBeenCalled();
    });
});
