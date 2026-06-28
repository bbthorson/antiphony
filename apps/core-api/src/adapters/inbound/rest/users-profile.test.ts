import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProfileView } from 'shared/types/views';

/**
 * Tests for `GET /api/v1/users/:handle/profile`.
 *
 * Identity-only: returns the basic (PII-free) profile for the resolved user.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        getUserData: vi.fn(),
    },
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
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

const { app } = await import('../../../app.js');
const { userService } = await import('../../outbound/firebase/core-services-firebase.js');

describe('GET /api/v1/users/:handle/profile', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the basic profile for the resolved user', async () => {
        const profile = { id: 'u-1', handle: 'alice', displayName: 'Alice', email: 'alice@example.com' };
        vi.mocked(userService.getUserData).mockResolvedValue(profile as unknown as ProfileView);

        const res = await app().request('/api/v1/users/alice/profile');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.handle).toBe('alice');
        expect(body.data.displayName).toBe('Alice');
        // PII must not cross the public projection boundary.
        expect(body.data.email).toBeUndefined();
    });

    it('returns 404 when the user cannot be resolved', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/nobody/profile');

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toMatchObject({
            success: false,
            error: { message: 'User not found' },
        });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        const profile = { id: 'u-1', handle: 'alice', displayName: 'Alice' };
        vi.mocked(userService.getUserData).mockResolvedValue(profile as unknown as ProfileView);

        const res = await app().request('/api/v1/users/alice/profile', {
            headers: { 'x-request-id': 'trace-uprofile' },
        });

        expect(res.headers.get('x-request-id')).toBe('trace-uprofile');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(userService.getUserData).mockRejectedValue(new Error('firestore outage'));

        const res = await app().request('/api/v1/users/alice/profile');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
