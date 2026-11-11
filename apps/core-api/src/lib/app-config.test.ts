import { describe, it, expect, afterEach } from 'vitest';
import { assertRequiredConfig, publicBaseUrl, publicDidWeb, serviceDid, servicePublicKey, serviceSigningKey } from './app-config.js';

/**
 * The regression these cover is an OUTAGE THAT ALREADY HAPPENED:
 * `ANTIPHONY_PUBLIC_BASE_URL` was unset on the deployed service for a day,
 * `audioPlaybackUrl` returned null, and every post view hydrated with no embed
 * while still answering 200. The check exists to make that state unservable
 * rather than quiet, so these assert the refusal itself — not just that a
 * present value is accepted.
 *
 * `assertRequiredConfig` takes its env as a parameter precisely so this can be
 * tested without mutating `process.env` and leaking into other files.
 */
describe('assertRequiredConfig', () => {
    it('throws when a required var is absent', () => {
        expect(() => assertRequiredConfig({})).toThrow(/ANTIPHONY_PUBLIC_BASE_URL/);
        expect(() => assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev' })).toThrow(/ANTIPHONY_PDS_HOST/);
    });

    it('treats whitespace as absent, because a blank value degrades identically', () => {
        expect(() => assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL: '   ', ANTIPHONY_PDS_HOST: 'api.antiphony.dev' })).toThrow(
            /ANTIPHONY_PUBLIC_BASE_URL/,
        );
        expect(() => assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev', ANTIPHONY_PDS_HOST: '   ' })).toThrow(
            /ANTIPHONY_PDS_HOST/,
        );
    });

    it('names where to fix it, since the value lives in config rather than code', () => {
        expect(() => assertRequiredConfig({})).toThrow(/wrangler\.jsonc/);
    });

    it('passes when every required var is present', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
            }),
        ).not.toThrow();
    });

    it('ignores unrelated vars, so the required set stays the only gate', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                ANTIPHONY_RENDITION_SERVICE_URL: undefined,
                SOMETHING_ELSE: '',
            }),
        ).not.toThrow();
    });

    // Present is not usable: this value is concatenated into
    // `AudioEmbedView.url`, and the contract restricts that field to http(s).
    // A base URL that cannot produce a parseable playback URL is the same quiet
    // read-path outage as an absent one, so it fails at the same place.
    it.each([
        'api.antiphony.dev',
        '/api',
        'javascript:alert(1)',
        'file:///srv',
    ])('refuses a base URL that is not absolute http(s): %s', (ANTIPHONY_PUBLIC_BASE_URL) => {
        expect(() => assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL, ANTIPHONY_PDS_HOST: 'api.antiphony.dev' })).toThrow(
            /ANTIPHONY_PUBLIC_BASE_URL is not an absolute http\(s\) URL/,
        );
    });

    it('accepts a plain-http base, for self-hosted and local deployments', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'http://localhost:8787',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
            }),
        ).not.toThrow();
    });

    it('refuses ANTIPHONY_PROCESSING_STUB in production', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                NODE_ENV: 'production',
                ANTIPHONY_PROCESSING_STUB: 'true',
            }),
        ).toThrow(/ANTIPHONY_PROCESSING_STUB and ANTIPHONY_PROCESSING_INLINE are not permitted/);
    });

    it('refuses ANTIPHONY_PROCESSING_INLINE in production', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                NODE_ENV: 'production',
                ANTIPHONY_PROCESSING_INLINE: 'true',
            }),
        ).toThrow(/ANTIPHONY_PROCESSING_STUB and ANTIPHONY_PROCESSING_INLINE are not permitted/);
    });

    it('allows stub and inline in non-production environments', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_PDS_HOST: 'api.antiphony.dev',
                NODE_ENV: 'development',
                ANTIPHONY_PROCESSING_STUB: 'true',
                ANTIPHONY_PROCESSING_INLINE: 'true',
            }),
        ).not.toThrow();
    });
});

describe('publicBaseUrl', () => {
    it('strips trailing slashes so callers can concatenate a path', () => {
        const previous = process.env.ANTIPHONY_PUBLIC_BASE_URL;
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev//';
        try {
            expect(publicBaseUrl()).toBe('https://api.antiphony.dev');
        } finally {
            if (previous === undefined) delete process.env.ANTIPHONY_PUBLIC_BASE_URL;
            else process.env.ANTIPHONY_PUBLIC_BASE_URL = previous;
        }
    });
});

describe('serviceDid and publicDidWeb', () => {
    const saved = { base: process.env.ANTIPHONY_PUBLIC_BASE_URL, did: process.env.ANTIPHONY_SERVICE_DID };
    afterEach(() => {
        restore('ANTIPHONY_PUBLIC_BASE_URL', saved.base);
        restore('ANTIPHONY_SERVICE_DID', saved.did);
    });

    function restore(name: string, value: string | undefined) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    it('derives did:web from the host of the public base URL', () => {
        delete process.env.ANTIPHONY_SERVICE_DID;
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev/';
        expect(serviceDid()).toBe('did:web:api.antiphony.dev');
    });

    it('percent-encodes an explicit port, because a bare colon is a path separator in did:web', () => {
        delete process.env.ANTIPHONY_SERVICE_DID;
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'http://localhost:8787';
        expect(serviceDid()).toBe('did:web:localhost%3A8787');
        expect(publicDidWeb()).toBe('did:web:localhost%3A8787');
    });

    it('leaves a default port out, as URL does', () => {
        delete process.env.ANTIPHONY_SERVICE_DID;
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev:443';
        expect(serviceDid()).toBe('did:web:api.antiphony.dev');
    });

    it('prefers ANTIPHONY_SERVICE_DID, while publicDidWeb ignores it', () => {
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'https://api.antiphony.dev';
        process.env.ANTIPHONY_SERVICE_DID = 'did:web:other.example';
        expect(serviceDid()).toBe('did:web:other.example');
        expect(publicDidWeb()).toBe('did:web:api.antiphony.dev');
    });

    it('is undefined with no usable base URL', () => {
        delete process.env.ANTIPHONY_SERVICE_DID;
        delete process.env.ANTIPHONY_PUBLIC_BASE_URL;
        expect(serviceDid()).toBeUndefined();
        process.env.ANTIPHONY_PUBLIC_BASE_URL = 'not a url';
        expect(serviceDid()).toBeUndefined();
    });
});

describe('serviceSigningKey and servicePublicKey', () => {
    const saved = {
        priv: process.env.ANTIPHONY_SERVICE_SIGNING_KEY,
        pub: process.env.ANTIPHONY_SERVICE_PUBLIC_KEY,
    };
    afterEach(() => {
        if (saved.priv === undefined) delete process.env.ANTIPHONY_SERVICE_SIGNING_KEY;
        else process.env.ANTIPHONY_SERVICE_SIGNING_KEY = saved.priv;
        if (saved.pub === undefined) delete process.env.ANTIPHONY_SERVICE_PUBLIC_KEY;
        else process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = saved.pub;
    });

    it('read the env per call, trimmed', () => {
        delete process.env.ANTIPHONY_SERVICE_SIGNING_KEY;
        delete process.env.ANTIPHONY_SERVICE_PUBLIC_KEY;
        expect(serviceSigningKey()).toBeUndefined();
        expect(servicePublicKey()).toBeUndefined();
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = '  abc \n';
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = ' zQ ';
        expect(serviceSigningKey()).toBe('abc');
        expect(servicePublicKey()).toBe('zQ');
    });

    it('treat a blank value as absent', () => {
        process.env.ANTIPHONY_SERVICE_SIGNING_KEY = '   ';
        process.env.ANTIPHONY_SERVICE_PUBLIC_KEY = '';
        expect(serviceSigningKey()).toBeUndefined();
        expect(servicePublicKey()).toBeUndefined();
    });
});
