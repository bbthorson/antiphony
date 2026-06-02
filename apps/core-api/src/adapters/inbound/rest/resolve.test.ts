import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProfileView, OrganizationView } from 'shared/types';

/**
 * Tests for `GET /api/v1/resolve/:handle`.
 *
 * Mocks:
 *   - `core-services-firebase` exports `feedService` with `resolveHandle`.
 *     Same pattern as handles.test.ts — mock the singleton rather than
 *     the whole Firebase stack.
 *   - `firebase-admin` is stubbed because rate-limit middleware uses it;
 *     the transaction returns "not limited" so requests pass through.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    feedService: {
        resolveHandle: vi.fn(),
    },
    // The other singletons aren't referenced by the resolve route itself,
    // but exporting them keeps the mock shape compatible with the real
    // module so nothing else trips if vitest's import graph touches them.
    userService: {},
    organizationService: {},
    hydrationService: {},
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
const { feedService } = await import('../../outbound/firebase/core-services-firebase.js');

describe('GET /api/v1/resolve/:handle', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns a user resolution as { success: true, data: { type: "user", profile } }', async () => {
        const profile = { id: 'uid-123', handle: 'alice', displayName: 'Alice' };
        vi.mocked(feedService.resolveHandle).mockResolvedValue({
            type: 'user',
            profile: profile as unknown as ProfileView,
        });

        const res = await app().request('/api/v1/resolve/alice');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            success: true,
            data: {
                type: 'user',
                profile,
            },
        });
    });

    it('returns an org resolution as { success: true, data: { type: "org", org } }', async () => {
        const org = { record: { id: 'org-456', slug: 'acme', name: 'Acme Inc' }, memberCount: 7 };
        vi.mocked(feedService.resolveHandle).mockResolvedValue({
            type: 'org',
            org: org as unknown as OrganizationView,
        });

        const res = await app().request('/api/v1/resolve/acme');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
            success: true,
            data: {
                type: 'org',
                org,
            },
        });
    });

    it('returns data: null when the handle does not resolve', async () => {
        vi.mocked(feedService.resolveHandle).mockResolvedValue(null);

        const res = await app().request('/api/v1/resolve/nobody');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, data: null });
    });

    it('propagates the inbound X-Request-ID header', async () => {
        vi.mocked(feedService.resolveHandle).mockResolvedValue(null);

        const res = await app().request('/api/v1/resolve/anyone', {
            headers: { 'x-request-id': 'upstream-abc' },
        });

        expect(res.headers.get('x-request-id')).toBe('upstream-abc');
    });

    it('maps service errors to a 500 with requestId', async () => {
        vi.mocked(feedService.resolveHandle).mockRejectedValue(new Error('firestore offline'));

        const res = await app().request('/api/v1/resolve/boom');

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.message).toBe('Internal Server Error');
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
