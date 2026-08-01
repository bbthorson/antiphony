import { describe, it, expect, afterEach, vi } from 'vitest';
import { webhookConfigs } from './webhook-config.js';
import { logger } from './logger.js';

/**
 * Per-tenant webhook config parsing (`specs/enrichment-webhooks.md`, § Config).
 * Mirrors `parseAppDids`: `appId:value` pairs, split on the first colon, cached,
 * fail-closed per entry. The load-bearing rule is that a tenant configured with
 * only a url OR only a secret is a MISCONFIGURATION — excluded and logged, so it
 * never pushes unsigned or half-wired.
 *
 * A secret must also clear the same ≥32-char bar as every other secret in the
 * deployment, and a url must be https anywhere but loopback — the signature
 * rides in a header next to the payload it authenticates, so neither a weak key
 * nor a plaintext hop leaves it meaningful.
 */

/** A secret that clears the length floor; the specific bytes never matter here. */
const SECRET = `whsec_${'a'.repeat(32)}`;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('webhookConfigs', () => {
    it('pairs a tenant present in both maps into { url, secret }', () => {
        const configs = webhookConfigs(`vox-pop:https://bff.voxpop/hooks`, `vox-pop:${SECRET}`);
        expect(configs.get('vox-pop')).toEqual({ url: 'https://bff.voxpop/hooks', secret: SECRET });
    });

    it('splits on the first colon only, so a url with a port survives', () => {
        const secret = 's3cr3t:with:colons:and:more:than:enough:length';
        const configs = webhookConfigs('app:http://localhost:8787/hook', `app:${secret}`);
        expect(configs.get('app')).toEqual({ url: 'http://localhost:8787/hook', secret });
    });

    it('excludes and logs a tenant with a url but no secret', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('lonely-url:https://x/hook', `other:${SECRET}`);
        expect(configs.has('lonely-url')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'lonely-url', hasUrl: true, hasSecret: false }),
            expect.stringContaining('not both'),
        );
    });

    it('excludes and logs a tenant with a secret but no url', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('other:https://y/hook', `lonely-secret:${SECRET}`);
        expect(configs.has('lonely-secret')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'lonely-secret', hasUrl: false, hasSecret: true }),
            expect.stringContaining('not both'),
        );
    });

    it('drops an entry whose url is not http(s)', () => {
        vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('ftp-app:ftp://nope/hook', `ftp-app:${SECRET}`);
        expect(configs.has('ftp-app')).toBe(false);
    });

    it('drops a plaintext http url off loopback', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('plain:http://bff.example.com/hook', `plain:${SECRET}`);
        expect(configs.has('plain')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'plain', hostname: 'bff.example.com' }),
            expect.stringContaining('https off loopback'),
        );
    });

    it('allows plaintext http on loopback, so a receiver can be developed locally', () => {
        expect(webhookConfigs('dev:http://localhost:8787/hook', `dev:${SECRET}`).has('dev')).toBe(true);
        expect(webhookConfigs('dev:http://127.0.0.1:8787/hook', `dev:${SECRET}`).has('dev')).toBe(true);
    });

    it('drops a signing secret below the length floor', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('weak:https://bff/hook', 'weak:whsec_abc');
        expect(configs.has('weak')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'weak', minLength: 32, actualLength: 9 }),
            expect.stringContaining('too short'),
        );
    });

    it('is empty when nothing is configured (silent opt-out)', () => {
        expect(webhookConfigs(undefined, undefined).size).toBe(0);
        expect(webhookConfigs('', '').size).toBe(0);
    });

    it('ignores a malformed entry with no separator', () => {
        vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('good:https://ok/hook,noseparator', `good:${SECRET}`);
        expect(configs.get('good')).toEqual({ url: 'https://ok/hook', secret: SECRET });
        expect(configs.size).toBe(1);
    });
});
