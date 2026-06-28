import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProfileView } from 'shared/types/views';

/**
 * Tests for `GET /api/v1/resolve/:handle`.
 *
 * Mocks:
 *   - `core-services-firebase` exports `userService` with `getUserData`.
 *     The route projects the resolved profile through `toProfileViewBasic`.
 *   - `firebase-admin` is stubbed because rate-limit middleware uses it;
 *     the transaction returns "not limited" so requests pass through.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: {
        getUserData: vi.fn(),
    },
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({
        collection: () => ({
            doc: () => ({}),
        }),
        runTransaction: async (
            fn: (t: unknown) => Promise<boolean>,
        ) =>
            fn({
                get: async () => ({ exists: false, data: () => undefined }),
                set: () => undefined,
                update: () => undefined,
            }),
    }),
    getAdmin: () => ({
        firestore: {
            Timestamp: { fromMillis: (ms: number) => ({ _ms: ms }) },
        },
    }),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { userService } = await import('../../outbound/firebase/core-services-firebase.js');

describe('GET /api/v1/resolve/:handle', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns the basic profile projection when the handle resolves', async () => {
        const profile = { id: 'uid-123', handle: 'alice', displayName: 'Alice', email: 'alice@example.com' };
        vi.mocked(userService.getUserData).mockResolvedValue(profile as unknown as ProfileView);

        const res = await app().request('/api/v1/resolve/alice');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.id).toBe('uid-123');
        expect(body.data.handle).toBe('alice');
        expect(body.data.displayName).toBe('Alice');
        // PII must not cross the public projection boundary.
        expect(body.data.email).toBeUndefined();
    });

    it('returns data: null when the handle does not resolve', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);

        const res = await app().request('/api/v1/resolve/nobody');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: null });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(userService.getUserData).mockResolvedValue(null);

        const res = await app().request('/api/v1/resolve/anyone', {
            headers: { 'x-request-id': 'upstream-abc' },
        });

        expect(res.headers.get('x-request-id')).toBe('upstream-abc');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(userService.getUserData).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/resolve/boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Internal Server Error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
