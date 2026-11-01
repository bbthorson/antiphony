import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantDidRecord } from 'shared/types/dids';
import type { CustodyProof, DidRegistryDependencies } from '../ports/did-registry-dependencies';
import { DidRegistryService, DID_CUSTODY_DISPROVED, DID_REGISTERED_DIFFERENTLY, DID_TAKEN, DID_UNREACHABLE } from './did-registry';

/**
 * Registering the DIDs a tenant may write under besides its app DID
 * (specs/did-plc-and-multi-did-tenancy.md §3): custody proven first, one tenant
 * per DID, registrations never rewritten.
 */

const TABLE = 'did:plc:abcdefghijklmnopqrstuvwx';
const ORG = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const appDid = (originAppId: string) => `did:web:${originAppId}.example`;

function fakeDeps(proof: CustodyProof = { ok: true }) {
    const rows = new Map<string, TenantDidRecord>();
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const deps: DidRegistryDependencies = {
        getAppDid: appDid,
        isPinnedAppDid: (did) => did === appDid('bardcast') || did === appDid('voxpop'),
        proveCustody: vi.fn(async () => proof),
        getTenantDid: async (did) => rows.get(did) ?? null,
        insertTenantDid: vi.fn(async (input) => {
            if (rows.has(input.did)) return 'exists' as const;
            rows.set(input.did, { ...input, createdAt: new Date((clock += 1000)) });
            return 'inserted' as const;
        }),
        listTenantDids: async (originAppId, { limit }) => {
            const mine = [...rows.values()]
                .filter((r) => r.originAppId === originAppId)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            return { items: mine.slice(0, limit), nextCursor: mine.length > limit ? 'more' : null };
        },
    };
    return { deps, rows };
}

describe('DidRegistryService.register', () => {
    let deps: DidRegistryDependencies;
    let rows: Map<string, TenantDidRecord>;
    let svc: DidRegistryService;
    beforeEach(() => {
        ({ deps, rows } = fakeDeps());
        svc = new DidRegistryService(deps);
    });

    it('proves custody, then keeps the registration', async () => {
        const { view, created } = await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group', subjectRef: 'table.thornwood' });
        expect(created).toBe(true);
        expect(view).toEqual({ did: TABLE, role: 'group', subjectRef: 'table.thornwood', createdAt: '2026-11-01T00:00:01.000Z' });
        expect(deps.proveCustody).toHaveBeenCalledWith(TABLE);
        expect(rows.get(TABLE)?.originAppId).toBe('bardcast');
    });

    it('is a no-op the second time, without re-resolving the document', async () => {
        await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' });
        const again = await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' });
        expect(again.created).toBe(false);
        expect(deps.proveCustody).toHaveBeenCalledTimes(1);
    });

    it("refuses another tenant's DID, registered or pinned, with DID_TAKEN", async () => {
        await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' });
        await expect(svc.register({ originAppId: 'voxpop', did: TABLE, role: 'group' })).rejects.toMatchObject({ status: 409, code: DID_TAKEN });
        await expect(svc.register({ originAppId: 'bardcast', did: appDid('voxpop'), role: 'group' })).rejects.toMatchObject({
            status: 409,
            code: DID_TAKEN,
        });
    });

    it("refuses the tenant's own app DID, and a malformed DID, as 400s", async () => {
        await expect(svc.register({ originAppId: 'bardcast', did: appDid('bardcast'), role: 'group' })).rejects.toMatchObject({ status: 400 });
        await expect(svc.register({ originAppId: 'bardcast', did: 'not-a-did', role: 'group' })).rejects.toMatchObject({ status: 400 });
        expect(deps.proveCustody).not.toHaveBeenCalled();
    });

    it('refuses to rewrite a registration with a different subject', async () => {
        await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group', subjectRef: 'table.a' });
        await expect(svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group', subjectRef: 'table.b' })).rejects.toMatchObject({
            status: 409,
            code: DID_REGISTERED_DIFFERENTLY,
        });
    });

    it('refuses a DID whose document disproves custody (400), saving nothing', async () => {
        ({ deps, rows } = fakeDeps({ ok: false, kind: 'disproof', reason: 'no-custody-service-endpoint' }));
        svc = new DidRegistryService(deps);
        await expect(svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' })).rejects.toMatchObject({
            status: 400,
            code: DID_CUSTODY_DISPROVED,
        });
        expect(deps.insertTenantDid).not.toHaveBeenCalled();
    });

    it('answers 503 when the document is unreachable, saving nothing', async () => {
        ({ deps, rows } = fakeDeps({ ok: false, kind: 'unreachable', reason: 'did-doc-fetch-failed' }));
        svc = new DidRegistryService(deps);
        await expect(svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' })).rejects.toMatchObject({
            status: 503,
            code: DID_UNREACHABLE,
        });
        expect(rows.size).toBe(0);
    });

    it('judges a registration that raced in between the read and the insert', async () => {
        // Another tenant's insert lands after our read, before our insert.
        const real = deps.insertTenantDid;
        deps.insertTenantDid = vi.fn(async (input) => {
            rows.set(input.did, { did: input.did, originAppId: 'voxpop', role: 'group', createdAt: new Date() });
            return real(input);
        });
        await expect(svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' })).rejects.toMatchObject({ code: DID_TAKEN });
    });
});

describe('DidRegistryService reads', () => {
    it("reads and lists only the calling tenant's registrations", async () => {
        const { deps } = fakeDeps();
        const svc = new DidRegistryService(deps);
        await svc.register({ originAppId: 'bardcast', did: TABLE, role: 'group' });
        await svc.register({ originAppId: 'voxpop', did: ORG, role: 'group' });

        await expect(svc.get('bardcast', TABLE)).resolves.toMatchObject({ did: TABLE });
        await expect(svc.get('bardcast', ORG)).rejects.toMatchObject({ status: 404 });
        await expect(svc.get('bardcast', 'not-a-did')).rejects.toMatchObject({ status: 404 });
        expect((await svc.list('bardcast')).items.map((v) => v.did)).toEqual([TABLE]);
    });

    it('clamps the page size', async () => {
        const { deps } = fakeDeps();
        const spy = vi.spyOn(deps, 'listTenantDids');
        const svc = new DidRegistryService(deps);
        await svc.list('bardcast', { limit: 10_000 });
        await svc.list('bardcast', { limit: 0 });
        expect(spy.mock.calls.map(([, o]) => o.limit)).toEqual([200, 1]);
    });
});

describe('DidRegistryService on a deployment that cannot check custody', () => {
    it('registers nothing and answers 503 DIDS_UNAVAILABLE', async () => {
        const { deps, rows } = fakeDeps({ ok: false, kind: 'unconfigured', reason: 'no ANTIPHONY_PDS_HOST' });
        await expect(new DidRegistryService(deps).register({ originAppId: 'bardcast', did: TABLE, role: 'group' })).rejects.toMatchObject({
            status: 503,
            code: 'DIDS_UNAVAILABLE',
        });
        expect(rows.size).toBe(0);
    });
});
