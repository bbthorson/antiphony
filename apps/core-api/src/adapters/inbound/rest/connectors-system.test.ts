import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundError } from 'shared/errors';

/**
 * Tests for the connector ingestion endpoints at `/api/v1/system/connectors`
 * (system-auth): GET config-by-owner + POST status-report. These are how a
 * connector (e.g. apps/telephony) reads config and reports status across
 * owners, without a user bearer.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    connectorConfigService: {
        getConfig: vi.fn(),
        reportStatus: vi.fn(),
    },
    callForwardingService: {},
    screeningService: {},
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
const { connectorConfigService } = await import('../../outbound/firebase/core-services-firebase.js');

const SYSTEM_TOKEN = 'test-system-token-1234567890abcd'; // 32 chars
const sysAuth = { authorization: `Bearer ${SYSTEM_TOKEN}` };

function mkRecord(overrides: Record<string, unknown> = {}) {
    return {
        connectorType: 'telephony',
        ownerId: 'u-1',
        settings: { phoneNumber: '+15551234567' },
        secretRef: null,
        enabled: false,
        status: { state: 'pending' },
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        ...overrides,
    };
}

const originalToken = process.env.SYSTEM_AUTH_TOKEN;
beforeEach(() => {
    vi.resetAllMocks();
    process.env.SYSTEM_AUTH_TOKEN = SYSTEM_TOKEN;
});
afterEach(() => {
    process.env.SYSTEM_AUTH_TOKEN = originalToken;
});

describe('GET /api/v1/system/connectors/{connectorType}/config', () => {
    it('returns 200 with the config for the owner', async () => {
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(
            mkRecord() as Awaited<ReturnType<typeof connectorConfigService.getConfig>>,
        );

        const res = await app().request('/api/v1/system/connectors/telephony/config?ownerId=u-1', {
            headers: sysAuth,
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.ownerId).toBe('u-1');
        expect(connectorConfigService.getConfig).toHaveBeenCalledWith('u-1', 'telephony');
    });

    it('404s when no config exists', async () => {
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(null);
        const res = await app().request('/api/v1/system/connectors/telephony/config?ownerId=u-none', {
            headers: sysAuth,
        });
        expect(res.status).toBe(404);
    });

    it('400s without ownerId', async () => {
        const res = await app().request('/api/v1/system/connectors/telephony/config', { headers: sysAuth });
        expect(res.status).toBe(400);
    });

    it('400s on an unknown connector type', async () => {
        const res = await app().request('/api/v1/system/connectors/slack/config?ownerId=u-1', {
            headers: sysAuth,
        });
        expect(res.status).toBe(400);
    });

    it('401s without system auth', async () => {
        const res = await app().request('/api/v1/system/connectors/telephony/config?ownerId=u-1');
        expect(res.status).toBe(401);
    });
});

describe('POST /api/v1/system/connectors/{connectorType}/status', () => {
    const jsonInit = (body: unknown) => ({
        method: 'POST' as const,
        headers: { 'content-type': 'application/json', ...sysAuth },
        body: JSON.stringify(body),
    });

    it('reports status and returns the updated config', async () => {
        vi.mocked(connectorConfigService.reportStatus).mockResolvedValue(
            mkRecord({ status: { state: 'active' } }) as Awaited<
                ReturnType<typeof connectorConfigService.reportStatus>
            >,
        );

        const res = await app().request(
            '/api/v1/system/connectors/telephony/status',
            jsonInit({ ownerId: 'u-1', status: { state: 'active', data: { verificationStatus: 'verified' } } }),
        );
        expect(res.status).toBe(200);
        expect(connectorConfigService.reportStatus).toHaveBeenCalledWith(
            'u-1',
            'telephony',
            { state: 'active', data: { verificationStatus: 'verified' } },
            { enabled: undefined },
        );
    });

    it('passes through enabled (connector activation on verify)', async () => {
        vi.mocked(connectorConfigService.reportStatus).mockResolvedValue(
            mkRecord({ enabled: true, status: { state: 'active' } }) as Awaited<
                ReturnType<typeof connectorConfigService.reportStatus>
            >,
        );

        const res = await app().request(
            '/api/v1/system/connectors/telephony/status',
            jsonInit({ ownerId: 'u-1', status: { state: 'active' }, enabled: true }),
        );
        expect(res.status).toBe(200);
        expect(connectorConfigService.reportStatus).toHaveBeenCalledWith(
            'u-1',
            'telephony',
            { state: 'active' },
            { enabled: true },
        );
    });

    it('404s when the owner has no config', async () => {
        vi.mocked(connectorConfigService.reportStatus).mockRejectedValue(
            new NotFoundError('No telephony connector config for this owner'),
        );
        const res = await app().request(
            '/api/v1/system/connectors/telephony/status',
            jsonInit({ ownerId: 'u-none', status: { state: 'active' } }),
        );
        expect(res.status).toBe(404);
    });

    it('400s without ownerId', async () => {
        const res = await app().request(
            '/api/v1/system/connectors/telephony/status',
            jsonInit({ status: { state: 'active' } }),
        );
        expect(res.status).toBe(400);
        expect(connectorConfigService.reportStatus).not.toHaveBeenCalled();
    });

    it('401s without system auth', async () => {
        const res = await app().request('/api/v1/system/connectors/telephony/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ownerId: 'u-1', status: { state: 'active' } }),
        });
        expect(res.status).toBe(401);
    });
});
