import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for `PUT /api/v1/system/users/:uid/bluesky-identity`.
 *
 * System-auth-gated. Validates uid + body shape. Maps Firestore
 * NOT_FOUND (`update` on missing doc) to 404 with a clean envelope
 * so apps/web's callback can redirect with a meaningful error reason.
 */

const setBlueskyIdentity = vi.fn();
vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: { setBlueskyIdentity },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';
process.env.SYSTEM_AUTH_TOKEN = 'test-system-token-abcdef-1234567'; // 32 chars

const { app } = await import('../../../app.js');

const withSystemAuth = (extra: Record<string, string> = {}) => ({
    authorization: 'Bearer test-system-token-abcdef-1234567',
    'content-type': 'application/json',
    ...extra,
});

const validBody = JSON.stringify({ handle: 'brad.bsky.social', did: 'did:plc:abc' });

describe('PUT /api/v1/system/users/:uid/bluesky-identity', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('401s without system-auth', async () => {
        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: validBody,
        });
        expect(res.status).toBe(401);
    });

    it('400s on uid with slashes', async () => {
        const res = await app().request('/api/v1/system/users/has%2Fslash/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: validBody,
        });
        expect(res.status).toBe(400);
    });

    it('400s on invalid JSON body', async () => {
        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: 'not json',
        });
        expect(res.status).toBe(400);
    });

    it('400s on missing handle', async () => {
        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: JSON.stringify({ did: 'did:plc:abc' }),
        });
        expect(res.status).toBe(400);
    });

    it('400s on malformed did (no method prefix)', async () => {
        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: JSON.stringify({ handle: 'brad.bsky.social', did: 'plc:abc' }),
        });
        expect(res.status).toBe(400);
    });

    it.each([
        // Standard `did:plc` — the common AT Proto case.
        'did:plc:abc123def456',
        // `did:web` with a domain.
        'did:web:example.com',
        // `did:web` with a hierarchical path (extra colons).
        'did:web:example.com:user',
        // `did:web` with a percent-encoded port.
        'did:web:localhost%3A8080',
    ])('accepts %s as a valid DID', async (did) => {
        setBlueskyIdentity.mockResolvedValueOnce(undefined);

        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: JSON.stringify({ handle: 'brad.bsky.social', did }),
        });

        expect(res.status).toBe(200);
    });

    it('200 + envelope on success', async () => {
        setBlueskyIdentity.mockResolvedValueOnce(undefined);

        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: null });
        expect(setBlueskyIdentity).toHaveBeenCalledWith('user-1', {
            handle: 'brad.bsky.social',
            did: 'did:plc:abc',
        });
    });

    it('404s when the user doc is missing (NOT_FOUND from Firestore update)', async () => {
        const err = Object.assign(new Error('NOT_FOUND: No document to update'), {
            code: 5, // gRPC NOT_FOUND
        });
        setBlueskyIdentity.mockRejectedValueOnce(err);

        const res = await app().request('/api/v1/system/users/missing-uid/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('User not found');
    });

    it('passes unexpected errors through to the error handler as 500', async () => {
        setBlueskyIdentity.mockRejectedValueOnce(new Error('firestore offline'));

        const res = await app().request('/api/v1/system/users/user-1/bluesky-identity', {
            method: 'PUT',
            headers: withSystemAuth(),
            body: validBody,
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
