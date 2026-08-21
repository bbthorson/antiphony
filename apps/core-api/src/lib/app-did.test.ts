import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    parseAppDids,
    validateAllPins,
    getAppDid,
    getValidatedPin,
    resetValidatedPinsForTest,
    checkTenantRegistryDrift,
    didWebToUrl,
    custodyService,
    validateAppDid,
    ensureTenantPin,
    revalidateAllPins,
} from './app-did.js';

afterEach(() => {
    delete process.env.ANTIPHONY_APP_DIDS;
    resetValidatedPinsForTest();
});

describe('parseAppDids', () => {
    it('parses appId:did pairs, keeping the colons inside the DID', () => {
        const m = parseAppDids('vox-pop:did:web:did.voxpop.audio, other:did:plc:abc123');
        expect(m.get('vox-pop')).toBe('did:web:did.voxpop.audio');
        expect(m.get('other')).toBe('did:plc:abc123');
    });

    it('drops malformed and non-DID entries fail-closed', () => {
        const m = parseAppDids('good:did:web:x.com, noseparator, bad:notadid, :did:web:y.com');
        expect(m.get('good')).toBe('did:web:x.com');
        expect(m.has('bad')).toBe(false);
        expect(m.size).toBe(1);
    });

    it('returns empty for blank/undefined', () => {
        expect(parseAppDids('').size).toBe(0);
        expect(parseAppDids(undefined).size).toBe(0);
    });
});

describe('validateAllPins + getAppDid', () => {
    const doc = (id: string) => ({
        id,
        service: [
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' },
        ],
    });
    // Resolve each did.json by host, so a pin whose host isn't mapped 404s
    // (letting a test exercise a partial-failure boot).
    const fetchByHost = (byHost: Record<string, unknown>) =>
        vi.fn(async (url: string) => {
            const body = byHost[new URL(url).host];
            return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
        }) as unknown as typeof fetch;

    it('validates all pins, snapshots them, and getAppDid serves from the snapshot', async () => {
        const snap = await validateAllPins({
            raw: 'vox-pop:did:web:did.voxpop.audio',
            expectedPdsHost: 'api.antiphony.dev',
            fetchImpl: fetchByHost({ 'did.voxpop.audio': doc('did:web:did.voxpop.audio') }),
        });
        expect(snap.get('vox-pop')?.custody).toEqual({ endpoint: 'https://api.antiphony.dev', kind: 'pds' });
        expect(getAppDid('vox-pop')).toBe('did:web:did.voxpop.audio');
        expect(getValidatedPin('vox-pop')?.did).toBe('did:web:did.voxpop.audio');
    });

    it('fails closed: one invalid pin rejects the whole boot', async () => {
        await expect(
            validateAllPins({
                raw: 'vox-pop:did:web:did.voxpop.audio, evil:did:web:evil.com',
                // evil.com is unmapped ⇒ 404 ⇒ its pin fails validation.
                fetchImpl: fetchByHost({ 'did.voxpop.audio': doc('did:web:did.voxpop.audio') }),
            }),
        ).rejects.toThrow(/pin validation failed for tenant "evil"/);
    });

    it('getAppDid throws before validation has run (missed boot gate fails loud)', () => {
        expect(() => getAppDid('vox-pop')).toThrow(/not validated/);
    });

    it('getAppDid throws for an unpinned tenant after validation', async () => {
        await validateAllPins({
            raw: 'vox-pop:did:web:did.voxpop.audio',
            expectedPdsHost: 'api.antiphony.dev',
            fetchImpl: fetchByHost({ 'did.voxpop.audio': doc('did:web:did.voxpop.audio') }),
        });
        expect(() => getAppDid('ghost')).toThrow(/no validated app DID for tenant "ghost"/);
    });

    it('an empty pin set validates to an empty snapshot (no tenants configured yet)', async () => {
        const snap = await validateAllPins({ raw: '' });
        expect(snap.size).toBe(0);
        expect(() => getAppDid('vox-pop')).toThrow(/no validated app DID/);
    });
});

describe('checkTenantRegistryDrift', () => {
    const doc = (id: string) => ({
        id,
        service: [
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' },
        ],
    });
    const fetchOk = (body: unknown) =>
        vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

    const seedPins = () =>
        validateAllPins({
            raw: 'vox-pop:did:web:did.voxpop.audio',
            fetchImpl: fetchOk(doc('did:web:did.voxpop.audio')),
        });

    it('reports no drift when the token and pin registries agree', async () => {
        await seedPins();
        expect(checkTenantRegistryDrift(['vox-pop'])).toEqual({
            tokensWithoutPin: [],
            pinsWithoutToken: [],
        });
    });

    it('flags a tenant that has a token but no validated app-DID pin', async () => {
        await seedPins();
        const drift = checkTenantRegistryDrift(['vox-pop', 'bardcast']);
        expect(drift.tokensWithoutPin).toEqual(['bardcast']);
        expect(drift.pinsWithoutToken).toEqual([]);
    });

    it('flags a validated pin that has no auth token (unreachable pin)', async () => {
        await seedPins();
        const drift = checkTenantRegistryDrift([]);
        expect(drift.tokensWithoutPin).toEqual([]);
        expect(drift.pinsWithoutToken).toEqual(['vox-pop']);
    });

    it('dedupes repeated token app-ids (rotation window)', async () => {
        await seedPins();
        // Same appId twice (two live tokens mid-rotation) is not drift.
        expect(checkTenantRegistryDrift(['vox-pop', 'vox-pop']).tokensWithoutPin).toEqual([]);
    });
});

describe('didWebToUrl', () => {
    it('maps a bare host to /.well-known/did.json', () => {
        expect(didWebToUrl('did:web:did.voxpop.audio')).toBe('https://did.voxpop.audio/.well-known/did.json');
    });

    it('maps a hierarchical path', () => {
        expect(didWebToUrl('did:web:antiphony.dev:tenants:vox-pop')).toBe(
            'https://antiphony.dev/tenants/vox-pop/did.json',
        );
    });

    it('decodes a percent-encoded host port', () => {
        expect(didWebToUrl('did:web:localhost%3A8080')).toBe('https://localhost:8080/.well-known/did.json');
    });

    it('returns null for a non-did:web DID', () => {
        expect(didWebToUrl('did:plc:abc')).toBeNull();
    });

    it('returns null (never throws) for malformed percent-encoding', () => {
        expect(didWebToUrl('did:web:%zz')).toBeNull();
    });

    it('rejects a decoded host/path that smuggles path or userinfo characters', () => {
        // %2F -> '/', %40 -> '@' — would escape the host or inject userinfo.
        expect(didWebToUrl('did:web:evil.com%2Fpath')).toBeNull();
        expect(didWebToUrl('did:web:evil.com%40real.com')).toBeNull();
    });
});

describe('custodyService', () => {
    const pds = (endpoint: string) => ({
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: endpoint,
    });
    const spaceHost = (endpoint: string) => ({
        id: 'did:web:x.example#atproto_space_host',
        serviceEndpoint: endpoint,
    });

    it('finds the legacy endpoint by #atproto_pds id suffix', () => {
        expect(custodyService({ service: [pds('https://pds.example')] })).toEqual({
            endpoint: 'https://pds.example',
            kind: 'pds',
        });
    });

    it('finds the legacy endpoint by type', () => {
        expect(
            custodyService({
                service: [{ id: 'whatever', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds2.example' }],
            }),
        ).toEqual({ endpoint: 'https://pds2.example', kind: 'pds' });
    });

    it('accepts #atproto_space_host — the entry that lets a tenant stop calling us a PDS', () => {
        expect(custodyService({ service: [spaceHost('https://api.antiphony.dev')] })).toEqual({
            endpoint: 'https://api.antiphony.dev',
            kind: 'space-host',
        });
    });

    it('prefers the space host when a migrating document carries both', () => {
        // Order-independent: the protocol falls back to #atproto_pds only when
        // the space host is ABSENT, so first-match would be the wrong rule.
        const expected = { endpoint: 'https://new.example', kind: 'space-host' };
        expect(custodyService({ service: [pds('https://old.example'), spaceHost('https://new.example')] })).toEqual(expected);
        expect(custodyService({ service: [spaceHost('https://new.example'), pds('https://old.example')] })).toEqual(expected);
    });

    it('falls back to #atproto_pds when no space host is published', () => {
        expect(custodyService({ service: [pds('https://pds.example')] })?.kind).toBe('pds');
    });

    it('returns null when absent or malformed', () => {
        expect(custodyService({ service: [] })).toBeNull();
        expect(custodyService({})).toBeNull();
        expect(custodyService(null)).toBeNull();
    });

    it('ignores an entry whose serviceEndpoint is not a string', () => {
        expect(custodyService({ service: [{ id: '#atproto_space_host', serviceEndpoint: { uri: 'x' } }] })).toBeNull();
    });

    it('skips null / non-object service entries without crashing', () => {
        expect(custodyService({ service: [null, 'nope', pds('https://pds.example')] })).toEqual({
            endpoint: 'https://pds.example',
            kind: 'pds',
        });
    });
});

describe('validateAppDid', () => {
    const doc = (over: Record<string, unknown> = {}) => ({
        id: 'did:web:did.voxpop.audio',
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' }],
        ...over,
    });
    const fetchOk = (body: unknown) =>
        vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

    it('is ok for a valid doc with a matching PDS host', async () => {
        const r = await validateAppDid('did:web:did.voxpop.audio', {
            fetchImpl: fetchOk(doc()),
            expectedPdsHost: 'api.antiphony.dev',
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.custody.endpoint).toBe('https://api.antiphony.dev');
    });

    it('rejects a non-did:web DID before fetching', async () => {
        expect(await validateAppDid('did:plc:abc', {})).toMatchObject({ ok: false, reason: 'not-did-web' });
    });

    it('rejects an HTTP error resolving the doc', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
        expect(await validateAppDid('did:web:did.voxpop.audio', { fetchImpl })).toMatchObject({
            ok: false,
            reason: 'did-doc-http-404',
        });
    });

    it('rejects an id mismatch (doc claims a different DID)', async () => {
        const r = await validateAppDid('did:web:did.voxpop.audio', { fetchImpl: fetchOk(doc({ id: 'did:web:evil.com' })) });
        expect(r).toMatchObject({ ok: false, reason: 'did-doc-id-mismatch' });
    });

    it('rejects a doc with no custody service endpoint', async () => {
        const r = await validateAppDid('did:web:did.voxpop.audio', { fetchImpl: fetchOk(doc({ service: [] })) });
        expect(r).toMatchObject({ ok: false, reason: 'no-custody-service-endpoint' });
    });

    it('rejects a custody endpoint that does not point at Antiphony', async () => {
        const r = await validateAppDid('did:web:did.voxpop.audio', {
            fetchImpl: fetchOk(doc()),
            expectedPdsHost: 'other.host',
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/custody-endpoint-host-mismatch/);
    });

    it('fails closed when the fetch itself throws (timeout / network error)', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('timeout');
        }) as unknown as typeof fetch;
        const r = await validateAppDid('did:web:did.voxpop.audio', { fetchImpl });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/did-doc-fetch-failed/);
    });
});

/**
 * The layered per-tenant gate — the Workers replacement for the fail-closed
 * boot gate.
 *
 * The whole design turns on ONE distinction, so most of this file is about it:
 * a **disproof** (we read the document and it contradicts the pin) must fail
 * closed immediately, while an **unreachable** document (timeout, 5xx, network)
 * is absence of evidence and must fall back to the last proven snapshot. Getting
 * those the same way round is what turns a brief did:web outage into an outage
 * of ours — which the deploy workflow already complains about in its own
 * comments.
 */

const DID = 'did:web:tenant.example';
const PINS = `vox-pop:${DID}`;

/** A did:web document that proves custody, pointing its PDS at `host`. */
function doc(host = 'api.antiphony.dev') {
    return {
        id: DID,
        service: [
            {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: `https://${host}`,
            },
        ],
    };
}

const okFetch = (body: unknown = doc()) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

const statusFetch = (status: number) =>
    vi.fn(async () => ({ ok: false, status })) as unknown as typeof fetch;

const deadFetch = () =>
    vi.fn(async () => {
        throw new Error('timeout');
    }) as unknown as typeof fetch;

/** An in-memory stand-in for the KV namespace. */
function fakeKv() {
    const store = new Map<string, string>();
    return {
        store,
        kv: {
            get: async (k: string) => {
                const raw = store.get(k);
                return raw ? JSON.parse(raw) : null;
            },
            put: async (k: string, v: string) => void store.set(k, v),
            delete: async (k: string) => void store.delete(k),
        },
    };
}

describe('ensureTenantPin — freshness', () => {
    it('proves custody and serves it synchronously afterwards', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const fetchImpl = okFetch();

        await ensureTenantPin('vox-pop', { fetchImpl });

        // The point of doing the async work in middleware: `getAppDid` stays
        // synchronous, so packages/core never learns about any of this.
        expect(getAppDid('vox-pop')).toBe(DID);
    });

    it('does not re-resolve inside the freshness window', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const fetchImpl = okFetch();

        await ensureTenantPin('vox-pop', { fetchImpl });
        await ensureTenantPin('vox-pop', { fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('re-resolves once the entry ages past the freshness window', async () => {
        // This is what makes the replacement STRONGER than the boot gate, not
        // weaker: a Cloud Run process up for thirty days answers with a
        // thirty-day-old custody proof, because it is only taken at startup.
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const fetchImpl = okFetch();
        let clock = 1_000_000;

        await ensureTenantPin('vox-pop', { fetchImpl, now: () => clock });
        clock += 2 * 60 * 60 * 1000; // two hours
        await ensureTenantPin('vox-pop', { fetchImpl, now: () => clock });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('refuses a tenant with no pin at all', async () => {
        // Not a cache miss. An `at://` uri cannot be well-formed without a
        // proven DID authority, so this fails closed.
        process.env.ANTIPHONY_APP_DIDS = '';
        await expect(ensureTenantPin('vox-pop', { fetchImpl: okFetch() })).rejects.toThrow(
            /no app DID pinned/,
        );
    });
});

describe('ensureTenantPin — disproof vs unreachable', () => {
    it('fails closed and EVICTS when the document contradicts the pin', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const { kv } = fakeKv();
        let clock = 1_000_000;

        // First, a good proof, cached in both layers.
        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), kv, now: () => clock });
        expect(getAppDid('vox-pop')).toBe(DID);

        // Then the DID document is repointed at someone else's PDS.
        clock += 2 * 60 * 60 * 1000;
        await expect(
            ensureTenantPin('vox-pop', {
                fetchImpl: okFetch(doc('someone-else.example')),
                kv,
                expectedPdsHost: 'api.antiphony.dev',
                now: () => clock,
            }),
        ).rejects.toThrow(/custody-endpoint-host-mismatch/);

        // Eviction is the part that matters. A cached "yes" is now known to be
        // a cached WRONG answer, so leaving it would keep serving a custody
        // claim we have positively disproved.
        expect(() => getAppDid('vox-pop')).toThrow();
        expect(await kv.get('pin:vox-pop')).toBeNull();
    });

    it('serves the last proven snapshot when the document is unreachable', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        let clock = 1_000_000;

        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), now: () => clock });
        clock += 2 * 60 * 60 * 1000;

        // Absence of evidence, not evidence of absence.
        await expect(
            ensureTenantPin('vox-pop', { fetchImpl: deadFetch(), now: () => clock }),
        ).resolves.toBeUndefined();
        expect(getAppDid('vox-pop')).toBe(DID);
    });

    it('stops serving stale once the tolerance is exhausted', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        let clock = 1_000_000;

        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), now: () => clock });
        clock += 25 * 60 * 60 * 1000; // past the 24h bound

        await expect(
            ensureTenantPin('vox-pop', { fetchImpl: deadFetch(), now: () => clock }),
        ).rejects.toThrow(/cannot prove custody/);
    });

    it('does not let serving stale reset the staleness clock', async () => {
        // The subtle one. If a stale serve refreshed `validatedAt`, the 24h
        // bound would keep restarting and a permanently unreachable DID would
        // be served forever — the bound would exist and never expire.
        process.env.ANTIPHONY_APP_DIDS = PINS;
        let clock = 1_000_000;
        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), now: () => clock });

        // Serve stale repeatedly, each attempt past the retry backoff.
        for (const hours of [2, 6, 12, 20]) {
            clock = 1_000_000 + hours * 60 * 60 * 1000;
            await ensureTenantPin('vox-pop', { fetchImpl: deadFetch(), now: () => clock });
        }

        clock = 1_000_000 + 25 * 60 * 60 * 1000;
        await expect(
            ensureTenantPin('vox-pop', { fetchImpl: deadFetch(), now: () => clock }),
        ).rejects.toThrow(/cannot prove custody/);
    });

    it('backs off rather than paying the fetch timeout on every request', async () => {
        // Without this, an unreachable did:web host makes every request wait
        // out the 5s resolve before being served from the snapshot — "their DID
        // host is slow" becomes "our API is slow", which is most of the damage
        // the stale tolerance exists to prevent.
        process.env.ANTIPHONY_APP_DIDS = PINS;
        let clock = 1_000_000;
        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), now: () => clock });

        clock += 2 * 60 * 60 * 1000;
        const dead = deadFetch();
        await ensureTenantPin('vox-pop', { fetchImpl: dead, now: () => clock });
        // Three more requests within the backoff window.
        clock += 1000;
        await ensureTenantPin('vox-pop', { fetchImpl: dead, now: () => clock });
        await ensureTenantPin('vox-pop', { fetchImpl: dead, now: () => clock });

        expect(dead).toHaveBeenCalledTimes(1);
    });

    it('treats 404 as disproof and 503 as unreachable', async () => {
        // The server ANSWERED that there is no document (404) versus failed to
        // answer at all (503). Only the first says anything about the DID.
        process.env.ANTIPHONY_APP_DIDS = PINS;

        const gone = await validateAppDid(DID, { fetchImpl: statusFetch(404) });
        expect(gone.ok).toBe(false);
        if (!gone.ok) expect(gone.kind).toBe('disproof');

        const down = await validateAppDid(DID, { fetchImpl: statusFetch(503) });
        expect(down.ok).toBe(false);
        if (!down.ok) expect(down.kind).toBe('unreachable');
    });

    it('treats a 429 as unreachable, not as disproof', async () => {
        // A rate limiter in front of the DID host tells us nothing about
        // custody. Failing closed on one would hand any intermediary the
        // ability to take a tenant offline.
        const limited = await validateAppDid(DID, { fetchImpl: statusFetch(429) });
        expect(limited.ok).toBe(false);
        if (!limited.ok) expect(limited.kind).toBe('unreachable');
    });
});

describe('ensureTenantPin — the KV layer', () => {
    it('lets a cold isolate reuse what another isolate proved', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const { kv } = fakeKv();
        const first = okFetch();

        await ensureTenantPin('vox-pop', { fetchImpl: first, kv });
        // A cold isolate: local map cleared, KV intact.
        resetValidatedPinsForTest();

        const second = okFetch();
        await ensureTenantPin('vox-pop', { fetchImpl: second, kv });

        expect(second).not.toHaveBeenCalled();
        expect(getAppDid('vox-pop')).toBe(DID);
    });

    it('ignores a cached proof for a DID the config no longer pins', async () => {
        // The pin was repointed in config since the cache was written, so the
        // cached proof is about an authority this deployment no longer claims.
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const { kv } = fakeKv();
        await ensureTenantPin('vox-pop', { fetchImpl: okFetch(), kv });
        resetValidatedPinsForTest();

        process.env.ANTIPHONY_APP_DIDS = 'vox-pop:did:web:moved.example';
        const refetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ ...doc(), id: 'did:web:moved.example' }),
        })) as unknown as typeof fetch;

        await ensureTenantPin('vox-pop', { fetchImpl: refetch, kv });

        expect(refetch).toHaveBeenCalled();
        expect(getAppDid('vox-pop')).toBe('did:web:moved.example');
    });

    it('resolves directly rather than failing when the cache is broken', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        const brokenKv = {
            get: async () => {
                throw new Error('kv down');
            },
            put: async () => {
                throw new Error('kv down');
            },
            delete: async () => undefined,
        };

        await expect(
            ensureTenantPin('vox-pop', { fetchImpl: okFetch(), kv: brokenKv }),
        ).resolves.toBeUndefined();
        expect(getAppDid('vox-pop')).toBe(DID);
    });
});

describe('revalidateAllPins — the drift cron', () => {
    it('reports drift instead of throwing', async () => {
        // Nothing is serving this call. A pin that has genuinely drifted fails
        // closed on its own at the next request; the cron's job is to say so
        // BEFORE that request, which is the ongoing-custody property the boot
        // gate never had.
        process.env.ANTIPHONY_APP_DIDS = PINS;

        const drift = await revalidateAllPins({
            fetchImpl: okFetch(doc('someone-else.example')),
            expectedPdsHost: 'api.antiphony.dev',
        });

        expect(drift).toHaveLength(1);
        expect(drift[0]).toMatchObject({ originAppId: 'vox-pop', kind: 'disproof' });
    });

    it('reports nothing when every pin still proves out', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        await expect(
            revalidateAllPins({ fetchImpl: okFetch(), expectedPdsHost: 'api.antiphony.dev' }),
        ).resolves.toEqual([]);
    });

    it('refreshes the snapshot, so a quiet tenant stays warm', async () => {
        process.env.ANTIPHONY_APP_DIDS = PINS;
        await revalidateAllPins({ fetchImpl: okFetch() });
        expect(getAppDid('vox-pop')).toBe(DID);
    });
});
