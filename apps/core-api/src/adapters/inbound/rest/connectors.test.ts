import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from 'shared/errors';

/**
 * Tests for the connector control-plane endpoints at `/api/v1/connectors`
 * (Plan B). Uniform per-connector config CRUD + status + enable/disable.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    connectorConfigService: {
        getConfig: vi.fn(),
        saveConfig: vi.fn(),
        updateConfig: vi.fn(),
        setEnabled: vi.fn(),
        getStatus: vi.fn(),
        deleteConfig: vi.fn(),
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
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

// A full ConnectorConfigRecord for the telephony connector.
function mkRecord(overrides: Record<string, unknown> = {}) {
    return {
        connectorType: 'telephony' as const,
        ownerId: 'u-1',
        settings: { phoneNumber: '+15551234567', tier: 'free', voxpopNumber: '+15559999999' },
        secretRef: null,
        enabled: false,
        status: { state: 'unconfigured' as const },
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        ...overrides,
    } as unknown as Awaited<ReturnType<typeof connectorConfigService.getConfig>>;
}

const jsonInit = (body: unknown, method: 'PUT' | 'PATCH' = 'PUT') => ({
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: JSON.stringify(body),
});

beforeEach(() => {
    vi.resetAllMocks();
});

describe('GET /api/v1/connectors/{connectorType}/config', () => {
    it('returns 200 with the config when present', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(mkRecord());

        const res = await app().request('/api/v1/connectors/telephony/config', {
            headers: { authorization: 'Bearer t' },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.connectorType).toBe('telephony');
        expect(body.data.settings.phoneNumber).toBe('+15551234567');
        expect(connectorConfigService.getConfig).toHaveBeenCalledWith('u-1', 'telephony');
    });

    it('returns 404 when no config exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-none' });
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(null);

        const res = await app().request('/api/v1/connectors/telephony/config', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(404);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/connectors/telephony/config');
        expect(res.status).toBe(401);
    });

    it('400s on an unknown connectorType (allowlist enforced by param validation)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });

        const res = await app().request('/api/v1/connectors/slack/config', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(400);
        expect(connectorConfigService.getConfig).not.toHaveBeenCalled();
    });
});

describe('PUT /api/v1/connectors/{connectorType}/config', () => {
    it('creates/replaces and returns the stamped record', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.saveConfig).mockResolvedValue(
            mkRecord() as NonNullable<ReturnType<typeof mkRecord>>,
        );

        const res = await app().request(
            '/api/v1/connectors/telephony/config',
            jsonInit({ settings: { phoneNumber: '+15551234567' }, enabled: false }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(connectorConfigService.saveConfig).toHaveBeenCalledWith(
            'u-1',
            'telephony',
            expect.objectContaining({ enabled: false }),
        );
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/connectors/telephony/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: {} }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on an invalid envelope field (enabled not boolean)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });

        const res = await app().request(
            '/api/v1/connectors/telephony/config',
            jsonInit({ settings: {}, enabled: 'yes' }),
        );
        expect(res.status).toBe(400);
        expect(connectorConfigService.saveConfig).not.toHaveBeenCalled();
    });

    it('400s on malformed JSON', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        const res = await app().request('/api/v1/connectors/telephony/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
            body: '{not-json',
        });
        expect(res.status).toBe(400);
    });

    it('strips a client-supplied status (connector-reported, not user-writable)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.saveConfig).mockResolvedValue(
            mkRecord() as NonNullable<ReturnType<typeof mkRecord>>,
        );

        const res = await app().request(
            '/api/v1/connectors/telephony/config',
            jsonInit({ settings: {}, enabled: true, status: { state: 'active' } }),
        );

        expect(res.status).toBe(200);
        // The schema omits `status`, so it never reaches the service.
        const passedInput = vi.mocked(connectorConfigService.saveConfig).mock.calls[0][2];
        expect(passedInput).not.toHaveProperty('status');
    });
});

describe('PATCH /api/v1/connectors/{connectorType}/config', () => {
    it('applies a partial update and returns the merged config', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.updateConfig).mockResolvedValue(
            mkRecord({ enabled: true }) as NonNullable<ReturnType<typeof mkRecord>>,
        );

        const res = await app().request(
            '/api/v1/connectors/telephony/config',
            jsonInit({ enabled: true }, 'PATCH'),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.enabled).toBe(true);
        expect(connectorConfigService.updateConfig).toHaveBeenCalledWith('u-1', 'telephony', {
            enabled: true,
        });
    });

    it('404s when no config exists (NotFoundError → 404)', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-none' });
        vi.mocked(connectorConfigService.updateConfig).mockRejectedValue(
            new NotFoundError('No telephony connector config for this owner'),
        );

        const res = await app().request(
            '/api/v1/connectors/telephony/config',
            jsonInit({ enabled: true }, 'PATCH'),
        );
        expect(res.status).toBe(404);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/connectors/telephony/config', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        });
        expect(res.status).toBe(401);
    });
});

describe('GET /api/v1/connectors/{connectorType}/status', () => {
    it('returns 200 with the status', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.getStatus).mockResolvedValue({ state: 'active' });

        const res = await app().request('/api/v1/connectors/telephony/status', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.state).toBe('active');
    });

    it('404s when no config exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-none' });
        vi.mocked(connectorConfigService.getStatus).mockResolvedValue(null);

        const res = await app().request('/api/v1/connectors/telephony/status', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(404);
    });
});

describe('POST /api/v1/connectors/{connectorType}/enable|disable', () => {
    it('enable flips enabled to true', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.setEnabled).mockResolvedValue(
            mkRecord({ enabled: true }) as NonNullable<ReturnType<typeof mkRecord>>,
        );

        const res = await app().request('/api/v1/connectors/telephony/enable', {
            method: 'POST',
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        expect(connectorConfigService.setEnabled).toHaveBeenCalledWith('u-1', 'telephony', true);
    });

    it('disable flips enabled to false', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(connectorConfigService.setEnabled).mockResolvedValue(
            mkRecord({ enabled: false }) as NonNullable<ReturnType<typeof mkRecord>>,
        );

        const res = await app().request('/api/v1/connectors/telephony/disable', {
            method: 'POST',
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        expect(connectorConfigService.setEnabled).toHaveBeenCalledWith('u-1', 'telephony', false);
    });

    it('404s when no config exists', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-none' });
        vi.mocked(connectorConfigService.setEnabled).mockRejectedValue(
            new NotFoundError('No telephony connector config for this owner'),
        );

        const res = await app().request('/api/v1/connectors/telephony/enable', {
            method: 'POST',
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(404);
    });

    it('401s without auth', async () => {
        const res = await app().request('/api/v1/connectors/telephony/enable', { method: 'POST' });
        expect(res.status).toBe(401);
    });
});
