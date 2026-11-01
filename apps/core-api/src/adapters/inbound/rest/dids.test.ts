import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantDidRecord } from 'shared/types/dids';
import type { CustodyProof } from '@antiphony/core/ports/did-registry-dependencies';

/**
 * Route tests for `/api/v1/dids`. The real `DidRegistryService` over an
 * in-memory store, so the custody, one-tenant-per-DID and no-rewrite rules are
 * the service's own; the Postgres binding has its own suite.
 */

const { DidRegistryService } = await import('@antiphony/core/services/did-registry');
const rows = new Map<string, TenantDidRecord>();
let custody: CustodyProof = { ok: true };
const didRegistryService = new DidRegistryService({
    getAppDid: (originAppId) => `did:web:${originAppId}.example`,
    isPinnedAppDid: (did) => did === 'did:web:test-app.example' || did === 'did:web:other-app.example',
    proveCustody: async () => custody,
    getTenantDid: async (did) => rows.get(did) ?? null,
    insertTenantDid: async (input) => {
        if (rows.has(input.did)) return 'exists';
        rows.set(input.did, { ...input, createdAt: new Date('2026-11-01T00:00:00Z') });
        return 'inserted';
    },
    deleteTenantDid: async (originAppId, did) => {
        const row = rows.get(did);
        if (!row || row.originAppId !== originAppId) return 'absent';
        rows.delete(did);
        return 'deleted';
    },
    listTenantDids: async (originAppId, { limit }) => {
        const mine = [...rows.values()].filter((r) => r.originAppId === originAppId);
        return { items: mine.slice(0, limit), nextCursor: null };
    },
});

vi.mock('../../../composition.js', () => ({
    servicesFor: () => ({
        didRegistryService,
        rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

const SERVICE_TOKEN = 'svc-tok-abcdefghijklmnopqrstuvwxyz012345';
const OTHER_TOKEN = 'svc-tok-zyxwvutsrqponmlkjihgfedcba543210';
process.env.LOG_LEVEL = 'silent';
process.env.ANTIPHONY_APP_TOKENS = `test-app:${SERVICE_TOKEN},other-app:${OTHER_TOKEN}`;

const { app } = await import('../../../app.js');
const { seedValidatedPins } = await import('../../../lib/testing/seed-pins.js');
await seedValidatedPins({ 'test-app': 'did:web:test-app.example', 'other-app': 'did:web:other-app.example' });

const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const put = (did: string, body: unknown, token = SERVICE_TOKEN) =>
    app().request(`/api/v1/dids/${encodeURIComponent(did)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
const get = (path: string, token = SERVICE_TOKEN) => app().request(path, { headers: { authorization: `Bearer ${token}` } });

describe('/api/v1/dids', () => {
    beforeEach(() => {
        rows.clear();
        custody = { ok: true };
    });

    it('registers a DID (201), then answers a repeat with 200', async () => {
        const first = await put(TABLE, { role: 'group', subjectRef: 'table.thornwood' });
        expect(first.status).toBe(201);
        expect((await first.json()).data).toEqual({
            did: TABLE,
            role: 'group',
            subjectRef: 'table.thornwood',
            createdAt: '2026-11-01T00:00:00.000Z',
        });
        expect((await put(TABLE, { role: 'group', subjectRef: 'table.thornwood' })).status).toBe(200);
    });

    it('accepts the DID with its colons unencoded in the path', async () => {
        const res = await app().request(`/api/v1/dids/${TABLE}`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'group' }),
        });
        expect(res.status).toBe(201);
    });

    it("refuses another tenant's DID with 409 DID_TAKEN, and hides it from their reads", async () => {
        await put(TABLE, { role: 'group' });
        const res = await put(TABLE, { role: 'group' }, OTHER_TOKEN);
        expect(res.status).toBe(409);
        expect((await res.json()).error.code).toBe('DID_TAKEN');
        expect((await get(`/api/v1/dids/${TABLE}`, OTHER_TOKEN)).status).toBe(404);
        expect((await (await get('/api/v1/dids', OTHER_TOKEN)).json()).data.items).toEqual([]);
    });

    it('answers a disproved custody claim with 400 and an unreachable document with 503', async () => {
        custody = { ok: false, kind: 'disproof', reason: 'custody-endpoint-host-mismatch' };
        const disproved = await put(TABLE, { role: 'group' });
        expect(disproved.status).toBe(400);
        expect((await disproved.json()).error.code).toBe('DID_CUSTODY_DISPROVED');

        custody = { ok: false, kind: 'unreachable', reason: 'did-doc-fetch-failed' };
        const unreachable = await put(TABLE, { role: 'group' });
        expect(unreachable.status).toBe(503);
        expect((await unreachable.json()).error.code).toBe('DID_UNREACHABLE');
        expect(rows.size).toBe(0);
    });

    it('validates the body: an unknown role is a 400', async () => {
        expect((await put(TABLE, { role: 'person' })).status).toBe(400);
    });

    it("reads and lists the tenant's own registrations", async () => {
        await put(TABLE, { role: 'group' });
        expect((await (await get(`/api/v1/dids/${TABLE}`)).json()).data.did).toBe(TABLE);
        const page = (await (await get('/api/v1/dids?limit=10')).json()).data;
        expect(page).toEqual({ items: [expect.objectContaining({ did: TABLE })], nextCursor: null });
    });

    it('unregisters a DID, and answers a repeat with deleted: false', async () => {
        await put(TABLE, { role: 'group' });
        const del = () => app().request(`/api/v1/dids/${TABLE}`, { method: 'DELETE', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
        expect((await (await del()).json()).data).toEqual({ deleted: true });
        expect((await (await del()).json()).data).toEqual({ deleted: false });
    });

    it('needs a service token', async () => {
        expect((await get('/api/v1/dids', 'nope')).status).toBe(401);
    });
});
