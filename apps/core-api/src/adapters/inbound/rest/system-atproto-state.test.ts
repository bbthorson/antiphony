import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `/api/v1/system/atproto-state/:key` GET/PUT/DELETE.
 *
 * System-auth-gated: missing/invalid bearer → 401. With valid bearer:
 *   - GET returns the state JSON or 404 (and deletes the expired doc).
 *   - PUT stores the state with a serverTimestamp.
 *   - DELETE removes the doc; idempotent — DELETE of a missing key
 *     still succeeds (Firestore `delete` on a missing doc is a no-op).
 */

const docGet = vi.fn();
const docSet = vi.fn();
const docDelete = vi.fn();

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (name: string) => ({
            doc: (id: string) => ({
                __name: name,
                __id: id,
                get: () => docGet(name, id),
                set: (data: unknown) => docSet(name, id, data),
                delete: () => docDelete(name, id),
            }),
        }),
    }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';
process.env.SYSTEM_AUTH_TOKEN = 'test-system-token-abcdef-1234567'; // 32 chars

const { app } = await import('../../../app.js');

function withSystemAuth(headers: Record<string, string> = {}): Record<string, string> {
    return { authorization: 'Bearer test-system-token-abcdef-1234567', ...headers };
}

describe('/api/v1/system/atproto-state/:key', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe('GET', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc');
            expect(res.status).toBe(401);
        });

        it('401s with wrong bearer', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: { authorization: 'Bearer wrong' },
            });
            expect(res.status).toBe(401);
        });

        it('400s on key with slashes', async () => {
            const res = await app().request('/api/v1/system/atproto-state/has%2Fslash', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(400);
        });

        it('404s when the doc is missing', async () => {
            docGet.mockResolvedValueOnce({ exists: false });
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(404);
        });

        it('returns the state JSON when fresh', async () => {
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({
                    state: { iss: 'https://bsky.social', dpopKey: { kty: 'EC' } },
                    createdAt: { toMillis: () => Date.now() - 1000 },
                }),
            });

            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.data.state).toEqual({ iss: 'https://bsky.social', dpopKey: { kty: 'EC' } });
            expect(docDelete).not.toHaveBeenCalled();
        });

        it('deletes the doc and 404s when expired', async () => {
            const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({
                    state: { iss: 'https://bsky.social' },
                    createdAt: { toMillis: () => elevenMinutesAgo },
                }),
            });
            docDelete.mockResolvedValueOnce(undefined);

            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });

            expect(res.status).toBe(404);
            expect(docDelete).toHaveBeenCalledWith('atproto_oauth_states', 'abc');
        });

        it('accepts raw-number createdAt for backward compat with older docs', async () => {
            // The previous in-process implementation used
            // `FieldValue.serverTimestamp()` for new writes but raw
            // `Date.now()` would also have worked. Both must round-trip.
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({
                    state: { iss: 'https://bsky.social' },
                    createdAt: Date.now() - 1000,
                }),
            });

            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });

            expect(res.status).toBe(200);
        });

        it('fails closed when createdAt is missing — returns 404 and cleans up', async () => {
            // OAuth crypto material with unknown age must not be
            // returned. Both null and an unrecognized createdAt shape
            // route through the "indeterminate age → expired" branch.
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({ state: { iss: 'https://bsky.social' } }),
            });
            docDelete.mockResolvedValueOnce(undefined);

            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });

            expect(res.status).toBe(404);
            expect(docDelete).toHaveBeenCalledWith('atproto_oauth_states', 'abc');
            const body = await res.json();
            expect(body.error.message).toBe('State invalid');
        });

        it('still returns 404 if the TTL-cleanup delete itself fails', async () => {
            // Cleanup is best-effort: if Firestore can't delete the
            // expired doc, the caller still gets a 404 (the state is
            // unusable either way). Surfacing the delete failure as a
            // 500 would make a transient Firestore error look like a
            // server bug to the OAuth library.
            const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({
                    state: { iss: 'https://bsky.social' },
                    createdAt: { toMillis: () => elevenMinutesAgo },
                }),
            });
            docDelete.mockRejectedValueOnce(new Error('firestore offline'));

            const res = await app().request('/api/v1/system/atproto-state/abc', {
                headers: withSystemAuth(),
            });

            expect(res.status).toBe(404);
            const body = await res.json();
            expect(body.error.message).toBe('State expired');
        });
    });

    describe('PUT', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state: {} }),
            });
            expect(res.status).toBe(401);
        });

        it('400s on invalid JSON body', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: 'not json',
            });
            expect(res.status).toBe(400);
        });

        it('400s when body is missing the `state` field', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
        });

        it('stores the state value', async () => {
            docSet.mockResolvedValueOnce(undefined);

            const state = { iss: 'https://bsky.social', verifier: 'pkce-v' };
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({ state }),
            });

            expect(res.status).toBe(200);
            expect(docSet).toHaveBeenCalledTimes(1);
            const [collection, key, written] = docSet.mock.calls[0];
            expect(collection).toBe('atproto_oauth_states');
            expect(key).toBe('abc');
            expect((written as { state: unknown }).state).toEqual(state);
        });
    });

    describe('DELETE', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'DELETE',
            });
            expect(res.status).toBe(401);
        });

        it('removes the doc', async () => {
            docDelete.mockResolvedValueOnce(undefined);
            const res = await app().request('/api/v1/system/atproto-state/abc', {
                method: 'DELETE',
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(200);
            expect(docDelete).toHaveBeenCalledWith('atproto_oauth_states', 'abc');
        });

        it('is idempotent — DELETE of a missing key returns success', async () => {
            // Firestore `delete` on a missing doc is a no-op; the route
            // doesn't pre-check existence, so success is expected.
            docDelete.mockResolvedValueOnce(undefined);
            const res = await app().request('/api/v1/system/atproto-state/never-existed', {
                method: 'DELETE',
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(200);
        });
    });
});
