import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/pglite.js';
import { postgresDidRegistryDependencies } from './did-registry-dependencies.js';

vi.mock('../../../lib/app-did.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/app-did.js')>()),
    getAppDid: () => 'did:web:bardcast.example',
    parseAppDids: () => new Map([['bardcast', 'did:web:bardcast.example'], ['voxpop', 'did:web:did.voxpop.audio']]),
}));

/**
 * Migration 0004 (`tenant_dids`) against real Postgres 18 (PGlite), and the
 * binding's custody check against a stubbed DID document.
 */

const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER = 'did:plc:zyxwvutsrqponmlkjihgfedc';

describe('tenant_dids (migration 0004)', () => {
    let db: TestDatabase;
    let deps: ReturnType<typeof postgresDidRegistryDependencies>;

    beforeAll(async () => {
        db = await createTestDatabase();
        deps = postgresDidRegistryDependencies(db);
    });
    afterAll(async () => db.close());
    beforeEach(async () => db.truncate());

    it('round-trips a registration, and keeps a DID to one tenant', async () => {
        expect(await deps.insertTenantDid({ did: TABLE, originAppId: 'bardcast', role: 'group', subjectRef: 'table.thornwood' })).toBe(
            'inserted',
        );
        expect(await deps.insertTenantDid({ did: TABLE, originAppId: 'voxpop', role: 'group' })).toBe('exists');
        expect(await deps.getTenantDid(TABLE)).toMatchObject({ did: TABLE, originAppId: 'bardcast', role: 'group', subjectRef: 'table.thornwood' });
        expect(await deps.getTenantDid(OTHER)).toBeNull();
    });

    it('refuses an unknown role, a non-DID, and an over-long subject', async () => {
        await expect(db.query(`insert into tenant_dids (did, origin_app_id, role) values ($1, 'bardcast', 'user')`, [TABLE])).rejects.toThrow();
        await expect(db.query(`insert into tenant_dids (did, origin_app_id, role) values ('alice', 'bardcast', 'group')`)).rejects.toThrow();
        await expect(
            db.query(`insert into tenant_dids (did, origin_app_id, role, subject_ref) values ($1, 'bardcast', 'group', $2)`, [TABLE, 'x'.repeat(257)]),
        ).rejects.toThrow();
    });

    it("lists one tenant's registrations newest first, paged by the last DID", async () => {
        const dids = ['a', 'b', 'c'].map((c) => `did:plc:${c.repeat(24)}`);
        for (const [i, did] of dids.entries()) {
            await db.query(`insert into tenant_dids (did, origin_app_id, role, created_at) values ($1, 'bardcast', 'group', $2)`, [
                did,
                `2026-11-01T00:00:0${i}Z`,
            ]);
        }
        await deps.insertTenantDid({ did: OTHER, originAppId: 'voxpop', role: 'group' });

        const first = await deps.listTenantDids('bardcast', { limit: 2 });
        expect(first.items.map((r) => r.did)).toEqual([dids[2], dids[1]]);
        expect(first.nextCursor).toBe(dids[1]);
        const second = await deps.listTenantDids('bardcast', { limit: 2, cursor: first.nextCursor! });
        expect(second.items.map((r) => r.did)).toEqual([dids[0]]);
        expect(second.nextCursor).toBeNull();
        // Another tenant's DID as a cursor starts from the top rather than leaking its position.
        expect((await deps.listTenantDids('bardcast', { limit: 5, cursor: OTHER })).items).toHaveLength(3);
    });

    it("knows every tenant's pinned app DID", () => {
        expect(deps.isPinnedAppDid('did:web:did.voxpop.audio')).toBe(true);
        expect(deps.isPinnedAppDid(TABLE)).toBe(false);
    });
});

describe('custody for a registered DID', () => {
    const doc = (host: string) => ({
        id: TABLE,
        service: [{ id: '#atproto_space_host', type: 'AtprotoSpaceHost', serviceEndpoint: `https://${host}` }],
    });
    const fetchDoc = (host: string) => (async () => new Response(JSON.stringify(doc(host)))) as unknown as typeof fetch;
    const sql = { query: async () => [] } as unknown as TestDatabase;

    it('passes when the document names this deployment', async () => {
        const deps = postgresDidRegistryDependencies(sql, { expectedPdsHost: 'core.antiphony.dev', fetchImpl: fetchDoc('core.antiphony.dev') });
        expect(await deps.proveCustody(TABLE)).toEqual({ ok: true });
    });

    it('is disproved when it names another host', async () => {
        const deps = postgresDidRegistryDependencies(sql, { expectedPdsHost: 'core.antiphony.dev', fetchImpl: fetchDoc('elsewhere.example') });
        expect(await deps.proveCustody(TABLE)).toMatchObject({ ok: false, kind: 'disproof' });
    });

    it('refuses to judge at all without an expected host, rather than accept any host', async () => {
        const deps = postgresDidRegistryDependencies(sql, { fetchImpl: fetchDoc('elsewhere.example') });
        expect(await deps.proveCustody(TABLE)).toMatchObject({ ok: false, kind: 'unconfigured' });
    });
});
