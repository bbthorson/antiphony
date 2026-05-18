import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from 'shared/errors';

/**
 * Tests for the call-forwarding data endpoints at
 * `/api/v1/users/me/call-forwarding`. Pure data CRUD — no Twilio in the
 * test surface. PR-E1 of the Post-4a roadmap.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    callForwardingService: {
        getConfig: vi.fn(),
        saveConfig: vi.fn(),
        updateConfig: vi.fn(),
        deleteConfig: vi.fn(),
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
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

// Minimal valid CallForwardingConfig — fields required by the Zod schema.
function mkConfig(overrides: Record<string, unknown> = {}) {
    return {
        phoneNumber: '+15551234567',
        lineType: 'mobile',
        carrier: 'Verizon',
        tier: 'free' as const,
        voxpopNumber: '+15559999999',
        twilioNumberSid: null,
        verificationStatus: 'pending' as const,
        verificationAttempts: 0,
        failureReason: null,
        enabled: false,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    } as unknown as Awaited<ReturnType<typeof callForwardingService.getConfig>>;
}

// Same shape minus the timestamps (server stamps those).
function mkInputBody(overrides: Record<string, unknown> = {}) {
    return {
        phoneNumber: '+15551234567',
        lineType: 'mobile',
        carrier: 'Verizon',
        tier: 'free' as const,
        voxpopNumber: '+15559999999',
        twilioNumberSid: null,
        verificationStatus: 'pending' as const,
        verificationAttempts: 0,
        failureReason: null,
        enabled: false,
        ...overrides,
    };
}

const jsonInit = (body: unknown, method: 'POST' | 'PATCH' = 'POST') => ({
    method,
    headers: {
        'content-type': 'application/json',
        authorization: 'Bearer t',
    },
    body: JSON.stringify(body),
});

describe('GET /api/v1/users/me/call-forwarding', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('returns 200 with the config when present', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(callForwardingService.getConfig).mockResolvedValue(mkConfig());

        const res = await app().request('/api/v1/users/me/call-forwarding', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.phoneNumber).toBe('+15551234567');
        expect(callForwardingService.getConfig).toHaveBeenCalledWith('u-1');
    });

    it('returns 404 when no config exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-no-config' });
        vi.mocked(callForwardingService.getConfig).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/me/call-forwarding', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(404);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/call-forwarding');
        expect(res.status).toBe(401);
    });
});

describe('POST /api/v1/users/me/call-forwarding', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('creates the config and returns the stamped record', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(callForwardingService.saveConfig).mockResolvedValue(
            mkConfig() as NonNullable<ReturnType<typeof mkConfig>>,
        );

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit(mkInputBody()),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.phoneNumber).toBe('+15551234567');
        expect(callForwardingService.saveConfig).toHaveBeenCalledWith(
            'u-1',
            expect.objectContaining({ phoneNumber: '+15551234567', tier: 'free' }),
        );
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(mkInputBody()),
        });
        expect(res.status).toBe(401);
    });

    it('400s on missing required field (phoneNumber)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const incomplete = mkInputBody();
        delete (incomplete as Record<string, unknown>).phoneNumber;

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit(incomplete),
        );

        expect(res.status).toBe(400);
        expect(callForwardingService.saveConfig).not.toHaveBeenCalled();
    });

    it('400s on invalid tier value', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit(mkInputBody({ tier: 'enterprise' })),
        );

        expect(res.status).toBe(400);
    });

    it('400s on malformed JSON body', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });

        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: 'Bearer t',
            },
            body: '{not-json',
        });

        expect(res.status).toBe(400);
    });
});

describe('PATCH /api/v1/users/me/call-forwarding', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('applies a partial update and returns the merged config', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(callForwardingService.updateConfig).mockResolvedValue(
            mkConfig({ verificationStatus: 'verified', enabled: true }) as NonNullable<
                ReturnType<typeof mkConfig>
            >,
        );

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit({ verificationStatus: 'verified', enabled: true }, 'PATCH'),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.verificationStatus).toBe('verified');
        expect(body.data.enabled).toBe(true);
        expect(callForwardingService.updateConfig).toHaveBeenCalledWith('u-1', {
            verificationStatus: 'verified',
            enabled: true,
        });
    });

    it('404s when no config exists (NotFoundError → errorHandler maps to 404)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-no-config' });
        vi.mocked(callForwardingService.updateConfig).mockRejectedValue(
            new NotFoundError('Call-forwarding config not found'),
        );

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit({ verificationStatus: 'verified' }, 'PATCH'),
        );

        expect(res.status).toBe(404);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on invalid update value', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });

        const res = await app().request(
            '/api/v1/users/me/call-forwarding',
            jsonInit({ verificationStatus: 'unknown-status' }, 'PATCH'),
        );

        expect(res.status).toBe(400);
        expect(callForwardingService.updateConfig).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/v1/users/me/call-forwarding', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('deletes and returns 200', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(callForwardingService.deleteConfig).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'DELETE',
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        expect(callForwardingService.deleteConfig).toHaveBeenCalledWith('u-1');
    });

    it('is idempotent — succeeds even when no config exists', async () => {
        // The binding's delete is a no-op on missing docs (Firestore semantics);
        // the service forwards. Behaviorally identical from the route's
        // perspective.
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-fresh' });
        vi.mocked(callForwardingService.deleteConfig).mockResolvedValue(undefined);

        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'DELETE',
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/call-forwarding', {
            method: 'DELETE',
        });
        expect(res.status).toBe(401);
    });
});
