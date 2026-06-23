import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelView } from 'shared/types/channels';

/**
 * Tests for the channels read-model at `GET /api/v1/users/me/channels`
 * (Phase 1 of specs/channels.md). Projects scattered per-user channel state
 * (telephony connector, SIP enrichment, linked Bluesky identity, always-on
 * surfaces) into a uniform inbound/outbound list.
 */

// SIP enrichment snapshot the getAdminDb mock returns — mutated per test.
let sipSnap: { exists: boolean; data: () => unknown } = { exists: false, data: () => undefined };

vi.mock('../../outbound/firebase/core-services-firebase.js', () => ({
    userService: { getUserDataByUid: vi.fn() },
    connectorConfigService: { getConfig: vi.fn() },
    callForwardingService: {},
    screeningService: {},
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
    getAdminDb: () => ({
        collection: () => ({
            doc: () => ({
                collection: () => ({ doc: () => ({ get: async () => sipSnap }) }),
            }),
        }),
    }),
    getAdmin: () => ({}),
    getAdminAuth: () => ({}),
    getAdminStorage: () => ({}),
    isUsingEmulator: () => false,
}));

process.env.LOG_LEVEL = 'silent';

const { app } = await import('../../../app.js');
const { userService, connectorConfigService } = await import('../../outbound/firebase/core-services-firebase.js');
const { sessionVerifier } = await import('../../../lib/auth/session-verifier.js');

const VALID_SIP = { sipUri: 'sip:u1@vox-pop', sipUsername: 'u1', sipSecret: 's', provider: 'twilio' };

function mkTelephony(overrides: Record<string, unknown> = {}) {
    return {
        connectorType: 'telephony' as const,
        ownerId: 'u-1',
        settings: {},
        secretRef: null,
        enabled: false,
        status: { state: 'unconfigured' as const },
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
        ...overrides,
    } as unknown as Awaited<ReturnType<typeof connectorConfigService.getConfig>>;
}

function byType(list: ChannelView[]): Record<string, ChannelView> {
    return Object.fromEntries(list.map((c) => [c.type, c]));
}

beforeEach(() => {
    vi.resetAllMocks();
    sipSnap = { exists: false, data: () => undefined };
});

describe('GET /api/v1/users/me/channels', () => {
    it('401s without auth', async () => {
        const res = await app().request('/api/v1/users/me/channels');
        expect(res.status).toBe(401);
    });

    it('404s when the profile is missing', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue(null);
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/me/channels', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(404);
    });

    it('projects a bare user: always-on active, others unconfigured/coming-soon', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue({ id: 'u-1' } as never);
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(null);

        const res = await app().request('/api/v1/users/me/channels', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        const { data } = await res.json();

        const inbound = byType(data.inbound);
        const outbound = byType(data.outbound);

        // Grouping by direction. SIP is folded into `phone` (an ingress
        // address, not its own channel); `phone-voicemail` is the outbound face.
        expect(Object.keys(inbound).sort()).toEqual(['bluesky-replies', 'phone', 'web-capture']);
        expect(Object.keys(outbound).sort()).toEqual(['bluesky-publishing', 'embed', 'phone-voicemail', 'rss', 'sms-invites']);

        // Always-on
        expect(inbound['web-capture']).toMatchObject({ state: 'active', enabled: true, alwaysOn: true });
        expect(outbound['rss']).toMatchObject({ state: 'active', enabled: true, alwaysOn: true });

        // Unconfigured — no telephony, no SIP → both phone faces unconfigured
        expect(inbound['phone']).toMatchObject({ state: 'unconfigured', enabled: false });
        expect(outbound['phone-voicemail']).toMatchObject({ state: 'unconfigured', enabled: false });
        expect(outbound['bluesky-publishing']).toMatchObject({
            state: 'unconfigured',
            enabled: false,
            dependsOn: 'bluesky-identity',
        });

        // Coming soon
        expect(inbound['bluesky-replies'].state).toBe('coming-soon');
        expect(outbound['sms-invites']).toMatchObject({ state: 'coming-soon', gated: true });
    });

    it('reflects a configured user: telephony active, SIP present, Bluesky linked', async () => {
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue({
            id: 'u-1',
            bluesky: { handle: 'me.bsky.social', did: 'did:plc:abc' },
        } as never);
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(
            mkTelephony({ enabled: true, status: { state: 'active', detail: 'Verified' } }),
        );
        sipSnap = { exists: true, data: () => VALID_SIP };

        const res = await app().request('/api/v1/users/me/channels', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        const { data } = await res.json();
        const inbound = byType(data.inbound);
        const outbound = byType(data.outbound);

        expect(inbound['phone']).toMatchObject({ state: 'active', enabled: true, statusDetail: 'Verified' });
        // SIP folded into phone (no own row); the outbound voicemail face is active.
        expect(inbound['sip']).toBeUndefined();
        expect(outbound['phone-voicemail']).toMatchObject({ state: 'active', enabled: true });
        expect(outbound['bluesky-publishing']).toMatchObject({ state: 'active', enabled: true });

        expect(connectorConfigService.getConfig).toHaveBeenCalledWith('u-1', 'telephony');
    });

    it('keeps phone enabled via SIP even when call forwarding is verified-but-disabled', async () => {
        // Edge flagged in review: forwarding connector is verified (state active)
        // but toggled OFF (enabled false), while a SIP address is provisioned.
        // SIP makes the channel reachable on its own, so it stays active+enabled.
        vi.mocked(sessionVerifier.verifyToken).mockResolvedValue({ uid: 'u-1' });
        vi.mocked(userService.getUserDataByUid).mockResolvedValue({ id: 'u-1' } as never);
        vi.mocked(connectorConfigService.getConfig).mockResolvedValue(
            mkTelephony({ enabled: false, status: { state: 'active', detail: 'Verified' } }),
        );
        sipSnap = { exists: true, data: () => VALID_SIP };

        const res = await app().request('/api/v1/users/me/channels', {
            headers: { authorization: 'Bearer t' },
        });
        expect(res.status).toBe(200);
        const { data } = await res.json();
        const inbound = byType(data.inbound);

        expect(inbound['phone']).toMatchObject({
            state: 'active',
            enabled: true,
            statusDetail: 'SIP address active',
        });
        // The outbound voicemail face is reachable too (telephony state active).
        expect(byType(data.outbound)['phone-voicemail']).toMatchObject({ state: 'active', enabled: true });
    });
});
