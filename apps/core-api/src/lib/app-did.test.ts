import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    parseAppDids,
    validateAllPins,
    getAppDid,
    getValidatedPin,
    resetValidatedPinsForTest,
    didWebToUrl,
    atprotoPdsEndpoint,
    validateAppDid,
} from './app-did.js';

afterEach(() => {
    delete process.env.ANTIPHONY_APP_DIDS;
    resetValidatedPinsForTest();
});

describe('parseAppDids', () => {
    it('parses appId:did pairs, keeping the colons inside the DID', () => {
        const m = parseAppDids('vox-pop:did:web:voxpop.com, other:did:plc:abc123');
        expect(m.get('vox-pop')).toBe('did:web:voxpop.com');
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
            raw: 'vox-pop:did:web:voxpop.com',
            expectedPdsHost: 'api.antiphony.dev',
            fetchImpl: fetchByHost({ 'voxpop.com': doc('did:web:voxpop.com') }),
        });
        expect(snap.get('vox-pop')?.pdsEndpoint).toBe('https://api.antiphony.dev');
        expect(getAppDid('vox-pop')).toBe('did:web:voxpop.com');
        expect(getValidatedPin('vox-pop')?.did).toBe('did:web:voxpop.com');
    });

    it('fails closed: one invalid pin rejects the whole boot', async () => {
        await expect(
            validateAllPins({
                raw: 'vox-pop:did:web:voxpop.com, evil:did:web:evil.com',
                // evil.com is unmapped ⇒ 404 ⇒ its pin fails validation.
                fetchImpl: fetchByHost({ 'voxpop.com': doc('did:web:voxpop.com') }),
            }),
        ).rejects.toThrow(/pin validation failed for tenant "evil"/);
    });

    it('getAppDid throws before validation has run (missed boot gate fails loud)', () => {
        expect(() => getAppDid('vox-pop')).toThrow(/not validated/);
    });

    it('getAppDid throws for an unpinned tenant after validation', async () => {
        await validateAllPins({
            raw: 'vox-pop:did:web:voxpop.com',
            expectedPdsHost: 'api.antiphony.dev',
            fetchImpl: fetchByHost({ 'voxpop.com': doc('did:web:voxpop.com') }),
        });
        expect(() => getAppDid('ghost')).toThrow(/no validated app DID for tenant "ghost"/);
    });

    it('an empty pin set validates to an empty snapshot (no tenants configured yet)', async () => {
        const snap = await validateAllPins({ raw: '' });
        expect(snap.size).toBe(0);
        expect(() => getAppDid('vox-pop')).toThrow(/no validated app DID/);
    });
});

describe('didWebToUrl', () => {
    it('maps a bare host to /.well-known/did.json', () => {
        expect(didWebToUrl('did:web:voxpop.com')).toBe('https://voxpop.com/.well-known/did.json');
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
});

describe('atprotoPdsEndpoint', () => {
    it('finds the endpoint by #atproto_pds id suffix', () => {
        expect(
            atprotoPdsEndpoint({
                service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }],
            }),
        ).toBe('https://pds.example');
    });

    it('finds the endpoint by type', () => {
        expect(
            atprotoPdsEndpoint({
                service: [{ id: 'whatever', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds2.example' }],
            }),
        ).toBe('https://pds2.example');
    });

    it('returns null when absent or malformed', () => {
        expect(atprotoPdsEndpoint({ service: [] })).toBeNull();
        expect(atprotoPdsEndpoint({})).toBeNull();
        expect(atprotoPdsEndpoint(null)).toBeNull();
    });
});

describe('validateAppDid', () => {
    const doc = (over: Record<string, unknown> = {}) => ({
        id: 'did:web:voxpop.com',
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' }],
        ...over,
    });
    const fetchOk = (body: unknown) =>
        vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

    it('is ok for a valid doc with a matching PDS host', async () => {
        const r = await validateAppDid('did:web:voxpop.com', {
            fetchImpl: fetchOk(doc()),
            expectedPdsHost: 'api.antiphony.dev',
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.pdsEndpoint).toBe('https://api.antiphony.dev');
    });

    it('rejects a non-did:web DID before fetching', async () => {
        expect(await validateAppDid('did:plc:abc', {})).toMatchObject({ ok: false, reason: 'not-did-web' });
    });

    it('rejects an HTTP error resolving the doc', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
        expect(await validateAppDid('did:web:voxpop.com', { fetchImpl })).toMatchObject({
            ok: false,
            reason: 'did-doc-http-404',
        });
    });

    it('rejects an id mismatch (doc claims a different DID)', async () => {
        const r = await validateAppDid('did:web:voxpop.com', { fetchImpl: fetchOk(doc({ id: 'did:web:evil.com' })) });
        expect(r).toMatchObject({ ok: false, reason: 'did-doc-id-mismatch' });
    });

    it('rejects a doc with no #atproto_pds endpoint', async () => {
        const r = await validateAppDid('did:web:voxpop.com', { fetchImpl: fetchOk(doc({ service: [] })) });
        expect(r).toMatchObject({ ok: false, reason: 'no-atproto-pds-endpoint' });
    });

    it('rejects a PDS endpoint that does not point at Antiphony', async () => {
        const r = await validateAppDid('did:web:voxpop.com', {
            fetchImpl: fetchOk(doc()),
            expectedPdsHost: 'other.host',
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/pds-endpoint-host-mismatch/);
    });
});
