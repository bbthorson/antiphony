import { describe, it, expect, afterEach, vi } from 'vitest';
import { webhookConfigs } from './webhook-config.js';
import { logger } from './logger.js';

/**
 * Per-tenant webhook config parsing (`specs/enrichment-webhooks.md`, § Config).
 * Mirrors `parseAppDids`: `appId:value` pairs, split on the first colon, cached,
 * fail-closed per entry. The load-bearing rule is that a tenant configured with
 * only a url OR only a secret is a MISCONFIGURATION — excluded and logged, so it
 * never pushes unsigned or half-wired.
 */

afterEach(() => {
    vi.restoreAllMocks();
});

describe('webhookConfigs', () => {
    it('pairs a tenant present in both maps into { url, secret }', () => {
        const configs = webhookConfigs('vox-pop:https://bff.voxpop/hooks', 'vox-pop:whsec_abc');
        expect(configs.get('vox-pop')).toEqual({ url: 'https://bff.voxpop/hooks', secret: 'whsec_abc' });
    });

    it('splits on the first colon only, so a url with a port survives', () => {
        const configs = webhookConfigs('app:http://localhost:8787/hook', 'app:s3cr3t:with:colons');
        expect(configs.get('app')).toEqual({ url: 'http://localhost:8787/hook', secret: 's3cr3t:with:colons' });
    });

    it('excludes and logs a tenant with a url but no secret', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('lonely-url:https://x/hook', 'other:whsec_x');
        expect(configs.has('lonely-url')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'lonely-url', hasUrl: true, hasSecret: false }),
            expect.stringContaining('not both'),
        );
    });

    it('excludes and logs a tenant with a secret but no url', () => {
        const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('other:https://y/hook', 'lonely-secret:whsec_y');
        expect(configs.has('lonely-secret')).toBe(false);
        expect(err).toHaveBeenCalledWith(
            expect.objectContaining({ appId: 'lonely-secret', hasUrl: false, hasSecret: true }),
            expect.stringContaining('not both'),
        );
    });

    it('drops an entry whose url is not http(s)', () => {
        vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('ftp-app:ftp://nope/hook', 'ftp-app:whsec_z');
        expect(configs.has('ftp-app')).toBe(false);
    });

    it('is empty when nothing is configured (silent opt-out)', () => {
        expect(webhookConfigs(undefined, undefined).size).toBe(0);
        expect(webhookConfigs('', '').size).toBe(0);
    });

    it('ignores a malformed entry with no separator', () => {
        vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const configs = webhookConfigs('good:https://ok/hook,noseparator', 'good:whsec_ok');
        expect(configs.get('good')).toEqual({ url: 'https://ok/hook', secret: 'whsec_ok' });
        expect(configs.size).toBe(1);
    });
});
