import { describe, it, expect } from 'vitest';
import { assertRequiredConfig, publicBaseUrl } from './app-config.js';

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
    });

    it('treats whitespace as absent, because a blank value degrades identically', () => {
        expect(() => assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL: '   ' })).toThrow(
            /ANTIPHONY_PUBLIC_BASE_URL/,
        );
    });

    it('names where to fix it, since the value lives in config rather than code', () => {
        expect(() => assertRequiredConfig({})).toThrow(/wrangler\.jsonc/);
    });

    it('passes when every required var is present', () => {
        expect(() =>
            assertRequiredConfig({ ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev' }),
        ).not.toThrow();
    });

    it('ignores unrelated vars, so the required set stays the only gate', () => {
        expect(() =>
            assertRequiredConfig({
                ANTIPHONY_PUBLIC_BASE_URL: 'https://api.antiphony.dev',
                ANTIPHONY_RENDITION_SERVICE_URL: undefined,
                SOMETHING_ELSE: '',
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
