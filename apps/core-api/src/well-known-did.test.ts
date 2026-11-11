import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateServiceKey } from './lib/service-key.js';

// Same seam as app.test.ts: the route needs no store, and an unmocked
// composition root would wait on one.
const rateLimitHit = vi.hoisted(() => vi.fn(async () => 'over' as 'over' | 'under'));

vi.mock('./composition.js', () => ({
    servicesFor: () => ({
        backend: 'postgres' as const,
        sql: { query: async () => [{ present: false }] },
        storage: { extractObjectPath: () => null },
        rateLimitStore: { hit: rateLimitHit },
    }),
}));

const { app } = await import('./app.js');
const { resetServiceDidDocumentCache } = await import('./lib/service-did-document.js');

const ENV_NAMES = [
    'ANTIPHONY_PUBLIC_BASE_URL',
    'ANTIPHONY_SERVICE_DID',
    'ANTIPHONY_SERVICE_SIGNING_KEY',
    'ANTIPHONY_SERVICE_PUBLIC_KEY',
    'LOG_LEVEL',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev';
    delete process.env.ANTIPHONY_SERVICE_DID;
    delete process.env.ANTIPHONY_SERVICE_SIGNING_KEY;
    delete process.env.ANTIPHONY_SERVICE_PUBLIC_KEY;
    process.env.LOG_LEVEL = 'silent';
    resetServiceDidDocumentCache();
});

afterEach(() => {
    for (const name of ENV_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    }
    vi.restoreAllMocks();
    rateLimitHit.mockClear();
});

function getDid(url = 'https://api.antiphony.dev/.well-known/did.json') {
    return app().fetch(new Request(url));
}

async function configure() {
    const key = await generateServiceKey();
    process.env.ANTIPHONY_SERVICE_SIGNING_KEY = key.privateKeyHex;
    process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = key.publicKeyMultibase;
    return key;
}

/** The unmatched-route response, which is what an unconfigured deployment answers today. */
async function unmatchedRoute() {
    const res = await app().fetch(new Request('https://api.antiphony.dev/.well-known/nothing-here'));
    return { status: res.status, body: await res.text() };
}

function loggedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('GET /.well-known/did.json', () => {
    it('answers 404, exactly like an unmatched route, with neither setting', async () => {
        const res = await getDid();
        expect(res.status).toBe(404);
        expect({ status: res.status, body: await res.text() }).toEqual(await unmatchedRoute());
    });

    it('answers 404 with only the secret', async () => {
        const key = await generateServiceKey();
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = key.privateKeyHex;
        expect((await getDid()).status).toBe(404);
    });

    it('answers 404 with only the public key', async () => {
        const key = await generateServiceKey();
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = key.publicKeyMultibase;
        expect((await getDid()).status).toBe(404);
    });

    it('answers 404 and logs an error naming the mismatch, never a key, when the pair differs', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env.LOG_LEVEL = 'error';
        const a = await generateServiceKey();
        const b = await generateServiceKey();
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = a.privateKeyHex;
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = b.publicKeyMultibase;

        expect((await getDid()).status).toBe(404);

        const lines = loggedLines(log);
        expect(lines).toHaveLength(1);
        const record = JSON.parse(lines[0]!);
        expect(record.level).toBe(50);
        expect(record.msg).toMatch(/ANTIPHONY_SERVICE_PUBLIC_KEY does not match/);
        for (const secret of [a.privateKeyHex, a.publicKeyMultibase, b.privateKeyHex, b.publicKeyMultibase]) {
            expect(lines[0]).not.toContain(secret);
        }
    });

    it('does not redo the derivation, or repeat the log line, on every request', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env.LOG_LEVEL = 'error';
        const a = await generateServiceKey();
        const b = await generateServiceKey();
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = a.privateKeyHex;
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = b.publicKeyMultibase;
        await getDid();
        await getDid();
        expect(loggedLines(log)).toHaveLength(1);
    });

    it('picks up a corrected pair without a restart, because the cache is keyed by both values', async () => {
        const a = await generateServiceKey();
        const b = await generateServiceKey();
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = a.privateKeyHex;
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = b.publicKeyMultibase;
        expect((await getDid()).status).toBe(404);
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = a.publicKeyMultibase;
        expect((await getDid()).status).toBe(200);
    });

    it.each([
        ['a private key that is not hex', { priv: 'not-a-key', pub: 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme' }],
        ['a public key that is not multibase', { priv: 'ab'.repeat(32), pub: 'not-a-multikey' }],
    ])('answers 404 and logs an error for %s', async (_name, { priv, pub }) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env.LOG_LEVEL = 'error';
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = priv;
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = pub;
        expect((await getDid()).status).toBe(404);
        expect(loggedLines(log)).toHaveLength(1);
        expect(loggedLines(log)[0]).not.toContain(priv);
    });

    it('answers 200 with exactly the document when the pair matches', async () => {
        const key = await configure();
        const res = await getDid();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
            id: 'did:web:api.antiphony.dev',
            verificationMethod: [
                {
                    id: 'did:web:api.antiphony.dev#atproto',
                    type: 'Multikey',
                    controller: 'did:web:api.antiphony.dev',
                    publicKeyMultibase: key.publicKeyMultibase,
                },
            ],
            service: [
                {
                    id: '#antiphony_audio',
                    type: 'AntiphonyAudioService',
                    serviceEndpoint: 'https://api.antiphony.dev',
                },
            ],
        });
    });

    it('never puts the private key in the document', async () => {
        const key = await configure();
        expect(await (await getDid()).text()).not.toContain(key.privateKeyHex);
    });

    it('follows ANTIPHONY_PUBLIC_BASE_URL for the DID and the endpoint', async () => {
        await configure();
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://audio.example.org/';
        const doc = await (await getDid('https://audio.example.org/.well-known/did.json')).json();
        expect(doc.id).toBe('did:web:audio.example.org');
        expect(doc.verificationMethod[0].id).toBe('did:web:audio.example.org#atproto');
        expect(doc.verificationMethod[0].controller).toBe('did:web:audio.example.org');
        expect(doc.service[0].serviceEndpoint).toBe('https://audio.example.org');
    });

    it('writes an explicit port as %3A in the DID', async () => {
        await configure();
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'http://localhost:8787';
        const doc = await (await getDid('http://localhost:8787/.well-known/did.json')).json();
        expect(doc.id).toBe('did:web:localhost%3A8787');
        expect(doc.service[0].serviceEndpoint).toBe('http://localhost:8787');
    });

    it('serves an ANTIPHONY_SERVICE_DID that is this host exactly', async () => {
        await configure();
        process.env.ANTIPHONY_SERVICE_DID = 'did:web:api.antiphony.dev';
        expect((await getDid()).status).toBe(200);
    });

    it.each([
        ['another host', 'did:web:elsewhere.example'],
        ['a path on this host', 'did:web:api.antiphony.dev:service'],
        ['a different method', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'],
        ['this host without the port encoding', 'did:web:api.antiphony.dev:443'],
    ])('answers 404 when ANTIPHONY_SERVICE_DID is %s', async (_name, did) => {
        await configure();
        process.env.ANTIPHONY_SERVICE_DID = did;
        expect((await getDid()).status).toBe(404);
    });

    it('answers 404 with no public base URL, because there is no host to be the DID of', async () => {
        await configure();
        delete process.env.ANTIPHONY_PUBLIC_BASE_URL;
        process.env.ANTIPHONY_SERVICE_DID = 'did:web:api.antiphony.dev';
        expect((await getDid()).status).toBe(404);
    });

    it('sends JSON, a short public cache lifetime, and headers that let a browser fetch it cross-origin', async () => {
        await configure();
        const res = await app().fetch(
            new Request('https://api.antiphony.dev/.well-known/did.json', { headers: { origin: 'https://resolver.example' } }),
        );
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        expect(res.headers.get('cache-control')).toBe('public, max-age=300');
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        // The global hardening still applies; none of it blocks reading a JSON body.
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('needs no credentials and is not rate limited', async () => {
        await configure();
        // The store above refuses everything, which would turn any rate-limited
        // route into a 429. This route must not consult it at all.
        for (let i = 0; i < 100; i++) expect((await getDid()).status).toBe(200);
        expect(rateLimitHit).not.toHaveBeenCalled();
    });

    it('is not in the OpenAPI document', async () => {
        await configure();
        const res = await app().fetch(new Request('https://api.antiphony.dev/openapi.json'));
        const doc = await res.json();
        expect(Object.keys(doc.paths)).not.toContain('/.well-known/did.json');
    });
});
