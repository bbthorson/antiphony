import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for `POST /api/v1/actors/register` and `GET /api/v1/actors/:actorId`
 * (B4-prep — the optional actor↔DID mapping, specs/service-auth.md).
 *
 * Exercises the FULL service-auth → route → service chain (no service-layer
 * mock) against a mocked Firestore, so the DID-from-header-not-body
 * invariant and tenancy scoping are verified end to end.
 */

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

const docs = new Map<string, Record<string, unknown>>();

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: (name: string) => ({
            doc: (id: string) => {
                const key = `${name}/${id}`;
                return {
                    get: async () => ({
                        exists: docs.has(key),
                        id,
                        data: () => docs.get(key),
                    }),
                    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
                        const existing = opts?.merge ? docs.get(key) ?? {} : {};
                        docs.set(key, { ...existing, ...data });
                    },
                };
            },
        }),
        runTransaction: async (fn: (t: unknown) => Promise<boolean>) =>
            fn({ get: async () => ({ exists: false, data: () => undefined }), set: () => undefined, update: () => undefined }),
    }),
    getAdmin: () => ({ firestore: { Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) } } }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');

const TOKEN = 'a'.repeat(32) + '-vox-pop-service-token';

describe('POST /api/v1/actors/register', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        docs.clear();
        process.env.ANTIPHONY_APP_TOKENS = `vox-pop:${TOKEN}`;
    });
    afterEach(() => {
        delete process.env.ANTIPHONY_APP_TOKENS;
    });

    it('401s without Authorization', async () => {
        const res = await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(401);
    });

    it('registers the DID from the header assertion, not the body', async () => {
        const res = await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-1',
                'x-antiphony-acting-actor-did': 'did:plc:abc123',
                'content-type': 'application/json',
            },
            // A spoofed did in the body must be ignored — only the header counts.
            body: JSON.stringify({ handle: 'brad', did: 'did:plc:spoofed' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual({ id: 'user-1', did: 'did:plc:abc123', handle: 'brad' });
    });

    it('400s when neither a DID assertion nor a handle is present', async () => {
        const res = await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-2',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('400s on a malformed DID', async () => {
        const res = await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-3',
                'x-antiphony-acting-actor-did': 'not-a-did',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('merge-preserves a previously registered did when only the handle is re-asserted', async () => {
        const headers = {
            authorization: `Bearer ${TOKEN}`,
            'x-antiphony-acting-actor': 'user-4',
            'content-type': 'application/json',
        };
        await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: { ...headers, 'x-antiphony-acting-actor-did': 'did:plc:xyz' },
            body: JSON.stringify({}),
        });
        const res2 = await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers,
            body: JSON.stringify({ handle: 'newhandle' }),
        });
        const body2 = await res2.json();
        expect(body2.data).toEqual({ id: 'user-4', did: 'did:plc:xyz', handle: 'newhandle' });
    });
});

describe('GET /api/v1/actors/:actorId', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        docs.clear();
        process.env.ANTIPHONY_APP_TOKENS = `vox-pop:${TOKEN}`;
    });
    afterEach(() => {
        delete process.env.ANTIPHONY_APP_TOKENS;
    });

    it('returns null for an unregistered actor', async () => {
        const res = await app().request('/api/v1/actors/nobody', {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        expect((await res.json()).data).toBeNull();
    });

    it('returns the registered identity, tenancy-scoped', async () => {
        await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-5',
                'x-antiphony-acting-actor-did': 'did:plc:qrs',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        const res = await app().request('/api/v1/actors/user-5', {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect((await res.json()).data).toEqual({ id: 'user-5', did: 'did:plc:qrs', handle: undefined });
    });

    it('hides a cross-tenant identity (different originAppId)', async () => {
        await app().request('/api/v1/actors/register', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-antiphony-acting-actor': 'user-6',
                'x-antiphony-acting-actor-did': 'did:plc:tuv',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        // Anonymous read (no service token) falls back to the env default
        // tenancy, which differs from 'vox-pop' — cross-tenant, so hidden.
        const res = await app().request('/api/v1/actors/user-6');
        expect((await res.json()).data).toBeNull();
    });
});
