import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `/api/v1/system/atproto-session/:key` GET/PUT/DELETE.
 *
 * System-auth-gated: missing/invalid bearer → 401. With valid bearer:
 *   - GET returns the ciphertext or 404 (no TTL — sessions are
 *     long-lived; the OAuth client refreshes them itself).
 *   - PUT stores the ciphertext with a serverTimestamp.
 *   - DELETE removes the doc; idempotent.
 *
 * Mirrors the system-atproto-state test pattern — same Firestore
 * mock shape, same system-auth helpers.
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

describe('/api/v1/system/atproto-session/:key', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe('GET', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc');
            expect(res.status).toBe(401);
        });

        it('401s with wrong bearer', async () => {
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                headers: { authorization: 'Bearer wrong' },
            });
            expect(res.status).toBe(401);
        });

        it('400s on invalid key (slash)', async () => {
            const res = await app().request('/api/v1/system/atproto-session/a%2Fb', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(400);
        });

        it('404s when the doc does not exist', async () => {
            docGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
            const res = await app().request('/api/v1/system/atproto-session/did:plc:missing', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(404);
        });

        it('404s when the doc lacks a ciphertext field (corruption guard)', async () => {
            docGet.mockResolvedValueOnce({ exists: true, data: () => ({ updatedAt: Date.now() }) });
            const res = await app().request('/api/v1/system/atproto-session/did:plc:corrupt', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(404);
        });

        it('returns the ciphertext envelope', async () => {
            docGet.mockResolvedValueOnce({
                exists: true,
                data: () => ({ ciphertext: 'base64url-encoded-ciphertext', updatedAt: Date.now() }),
            });
            const res = await app().request('/api/v1/system/atproto-session/did:plc:ok', {
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toEqual({ success: true, data: { ciphertext: 'base64url-encoded-ciphertext' } });
        });
    });

    describe('PUT', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ciphertext: 'x' }),
            });
            expect(res.status).toBe(401);
        });

        it('400s on missing ciphertext field', async () => {
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
        });

        it('400s on oversize ciphertext (defends against runaway payloads)', async () => {
            const huge = 'a'.repeat(64 * 1024 + 1);
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({ ciphertext: huge }),
            });
            expect(res.status).toBe(400);
        });

        it('writes the ciphertext with serverTimestamp', async () => {
            docSet.mockResolvedValueOnce(undefined);
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'PUT',
                headers: withSystemAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({ ciphertext: 'opaque-blob' }),
            });
            expect(res.status).toBe(200);
            const setCall = docSet.mock.calls[0];
            expect(setCall[0]).toBe('atproto_oauth_sessions');
            expect(setCall[1]).toBe('did:plc:abc');
            expect(setCall[2]).toMatchObject({ ciphertext: 'opaque-blob' });
            expect(setCall[2].updatedAt).toBeDefined();
        });
    });

    describe('DELETE', () => {
        it('401s without system-auth', async () => {
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'DELETE',
            });
            expect(res.status).toBe(401);
        });

        it('deletes the doc (idempotent — Firestore delete on missing is a no-op)', async () => {
            docDelete.mockResolvedValueOnce(undefined);
            const res = await app().request('/api/v1/system/atproto-session/did:plc:abc', {
                method: 'DELETE',
                headers: withSystemAuth(),
            });
            expect(res.status).toBe(200);
            expect(docDelete).toHaveBeenCalledWith('atproto_oauth_sessions', 'did:plc:abc');
        });
    });
});
