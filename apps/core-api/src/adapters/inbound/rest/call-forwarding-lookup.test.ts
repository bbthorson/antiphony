import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for `/api/v1/call-forwarding/by-phone` + `/by-dedicated`.
 * Both require system-auth (shared-secret bearer), NOT user-auth.
 * PR-E3 of the Post-4a roadmap.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    callForwardingService: {
        findUidByPhoneNumber: vi.fn(),
        findUidByDedicatedNumber: vi.fn(),
    },
    userService: {},
    organizationService: {},
    promptService: {},
    feedService: {},
    hydrationService: {},
    replyService: {},
    firebaseCoreServices: {},
}));

vi.mock('../../../lib/auth/session-verifier.js', () => ({
    sessionVerifier: { verifyToken: vi.fn() },
}));

vi.mock('../../../lib/firebase-admin.js', () => ({
    getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { callForwardingService } = await import('../../outbound/firebase/core-services-firebase.js');

const SYSTEM_TOKEN = 'test-system-token-1234567890abcd'; // 32 chars
const authHeader = { authorization: `Bearer ${SYSTEM_TOKEN}` };

describe('GET /api/v1/call-forwarding/by-phone', () => {
    const originalToken = process.env.SYSTEM_AUTH_TOKEN;

    beforeEach(() => {
        vi.resetAllMocks();
        process.env.SYSTEM_AUTH_TOKEN = SYSTEM_TOKEN;
    });

    afterEach(() => {
        if (originalToken === undefined) {
            delete process.env.SYSTEM_AUTH_TOKEN;
        } else {
            process.env.SYSTEM_AUTH_TOKEN = originalToken;
        }
    });

    it('returns the uid when a verified+enabled config matches', async () => {
        vi.mocked(callForwardingService.findUidByPhoneNumber).mockResolvedValue('u-target');

        const res = await app().request(
            '/api/v1/call-forwarding/by-phone?phoneNumber=%2B15551234567',
            { headers: authHeader },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.uid).toBe('u-target');
        expect(callForwardingService.findUidByPhoneNumber).toHaveBeenCalledWith('+15551234567');
    });

    it('returns 404 when no config matches', async () => {
        vi.mocked(callForwardingService.findUidByPhoneNumber).mockResolvedValue(null);

        const res = await app().request(
            '/api/v1/call-forwarding/by-phone?phoneNumber=%2B15559999999',
            { headers: authHeader },
        );

        expect(res.status).toBe(404);
    });

    it('returns 401 without the system token', async () => {
        const res = await app().request('/api/v1/call-forwarding/by-phone?phoneNumber=%2B1555');
        expect(res.status).toBe(401);
        expect(callForwardingService.findUidByPhoneNumber).not.toHaveBeenCalled();
    });

    it('returns 401 with a user bearer (not the system token)', async () => {
        const res = await app().request(
            '/api/v1/call-forwarding/by-phone?phoneNumber=%2B1555',
            { headers: { authorization: 'Bearer user-firebase-id-token' } },
        );
        expect(res.status).toBe(401);
        expect(callForwardingService.findUidByPhoneNumber).not.toHaveBeenCalled();
    });

    it('returns 400 when phoneNumber query param is missing', async () => {
        const res = await app().request(
            '/api/v1/call-forwarding/by-phone',
            { headers: authHeader },
        );
        expect(res.status).toBe(400);
        expect(callForwardingService.findUidByPhoneNumber).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/call-forwarding/by-dedicated', () => {
    const originalToken = process.env.SYSTEM_AUTH_TOKEN;

    beforeEach(() => {
        vi.resetAllMocks();
        process.env.SYSTEM_AUTH_TOKEN = SYSTEM_TOKEN;
    });

    afterEach(() => {
        if (originalToken === undefined) {
            delete process.env.SYSTEM_AUTH_TOKEN;
        } else {
            process.env.SYSTEM_AUTH_TOKEN = originalToken;
        }
    });

    it('returns the uid when a paid-tier verified config matches', async () => {
        vi.mocked(callForwardingService.findUidByDedicatedNumber).mockResolvedValue('u-paid');

        const res = await app().request(
            '/api/v1/call-forwarding/by-dedicated?voxpopNumber=%2B15558881234',
            { headers: authHeader },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.uid).toBe('u-paid');
        expect(callForwardingService.findUidByDedicatedNumber).toHaveBeenCalledWith('+15558881234');
    });

    it('returns 404 when no config matches', async () => {
        vi.mocked(callForwardingService.findUidByDedicatedNumber).mockResolvedValue(null);

        const res = await app().request(
            '/api/v1/call-forwarding/by-dedicated?voxpopNumber=%2B15559999999',
            { headers: authHeader },
        );

        expect(res.status).toBe(404);
    });

    it('returns 401 without the system token', async () => {
        const res = await app().request('/api/v1/call-forwarding/by-dedicated?voxpopNumber=%2B1555');
        expect(res.status).toBe(401);
    });

    it('returns 400 when voxpopNumber query param is missing', async () => {
        const res = await app().request(
            '/api/v1/call-forwarding/by-dedicated',
            { headers: authHeader },
        );
        expect(res.status).toBe(400);
    });
});
