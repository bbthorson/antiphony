import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from 'shared/errors';

/**
 * Tests for `/api/v1/users/me/screening/*` — the screening-allowlist CRUD.
 * Auth-required; mock the service (no Firestore) and the session-verifier
 * (a Bearer header resolves to a fixed uid). Mirrors the people.test harness.
 */

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    screeningService: {
        listRules: vi.fn(),
        createRule: vi.fn(),
        updateRule: vi.fn(),
        deleteRule: vi.fn(),
    },
    // Other services referenced by sibling route modules at import time.
    feedService: {},
    userService: {},
    organizationService: {},
    promptService: {},
    hydrationService: {},
    replyService: {},
    callForwardingService: {},
    rssService: {},
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
const { screeningService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

const BASE = '/api/v1/users/me/screening';

function authed(method: string, body?: unknown): RequestInit {
    return {
        method,
        headers: {
            Authorization: 'Bearer tok',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
}

function mkRule(over: Record<string, unknown> = {}) {
    return {
        id: 'rule-1',
        ownerId: 'viewer-1',
        e164: '+15551234567',
        label: null,
        action: 'allow',
        source: 'manual',
        expiresAt: null,
        createdAt: new Date().toISOString(),
        ...over,
    };
}

describe('screening allowlist routes', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'viewer-1' });
    });

    it('401s without a bearer token', async () => {
        const res = await app().request(BASE);
        expect(res.status).toBe(401);
    });

    it('GET / lists the viewer rules', async () => {
        vi.mocked(screeningService.listRules).mockResolvedValue([mkRule(), mkRule({ id: 'rule-2' })] as never);
        const res = await app().request(BASE, authed('GET'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(2);
        expect(screeningService.listRules).toHaveBeenCalledWith('viewer-1');
    });

    it('POST / creates a rule', async () => {
        vi.mocked(screeningService.createRule).mockResolvedValue(mkRule({ action: 'screen' }) as never);
        const res = await app().request(BASE, authed('POST', { e164: '+15551234567', action: 'screen' }));
        expect(res.status).toBe(200);
        expect(screeningService.createRule).toHaveBeenCalledWith('viewer-1', {
            e164: '+15551234567',
            action: 'screen',
        });
    });

    it('POST / rejects a non-E.164 number', async () => {
        const res = await app().request(BASE, authed('POST', { e164: '555-1234', action: 'allow' }));
        expect(res.status).toBe(400);
        expect(screeningService.createRule).not.toHaveBeenCalled();
    });

    it('POST / rejects an invalid action', async () => {
        const res = await app().request(BASE, authed('POST', { e164: '+15551234567', action: 'maybe' }));
        expect(res.status).toBe(400);
    });

    it('PATCH /:ruleId updates a rule', async () => {
        vi.mocked(screeningService.updateRule).mockResolvedValue(mkRule({ label: 'Mom' }) as never);
        const res = await app().request(`${BASE}/rule-1`, authed('PATCH', { label: 'Mom' }));
        expect(res.status).toBe(200);
        expect(screeningService.updateRule).toHaveBeenCalledWith('viewer-1', 'rule-1', { label: 'Mom' });
    });

    it('PATCH /:ruleId 404s on an unknown rule', async () => {
        vi.mocked(screeningService.updateRule).mockRejectedValue(new NotFoundError('Screening rule not found'));
        const res = await app().request(`${BASE}/missing`, authed('PATCH', { action: 'screen' }));
        expect(res.status).toBe(404);
    });

    it('DELETE /:ruleId removes a rule', async () => {
        vi.mocked(screeningService.deleteRule).mockResolvedValue();
        const res = await app().request(`${BASE}/rule-1`, authed('DELETE'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: null });
        expect(screeningService.deleteRule).toHaveBeenCalledWith('viewer-1', 'rule-1');
    });
});
