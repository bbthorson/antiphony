import { describe, it, expect } from 'vitest';
import { app, parseAllowedOrigins } from './app.js';

describe('parseAllowedOrigins', () => {
    it('falls back to localhost dev ports when env var is undefined', () => {
        expect(parseAllowedOrigins(undefined)).toEqual(['http://localhost:3002']);
    });

    it('falls back to localhost dev ports when env var is an empty string', () => {
        expect(parseAllowedOrigins('')).toEqual(['http://localhost:3002']);
    });

    it('falls back to localhost dev ports when env var is whitespace-only', () => {
        expect(parseAllowedOrigins('   ,  ,  ')).toEqual(['http://localhost:3002']);
    });

    it('parses a single origin', () => {
        expect(parseAllowedOrigins('https://example.com')).toEqual([
            'https://example.com',
        ]);
    });

    it('parses a comma-separated list', () => {
        expect(
            parseAllowedOrigins('https://example.com,https://app.example.com'),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('trims whitespace around entries', () => {
        expect(
            parseAllowedOrigins('  https://example.com , https://app.example.com  '),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });

    it('drops empty entries from the list', () => {
        expect(
            parseAllowedOrigins('https://example.com,,https://app.example.com,'),
        ).toEqual(['https://example.com', 'https://app.example.com']);
    });
});

describe('OpenAPI document', () => {
    it('serves a well-formed spec at /openapi.json with the /users/* family present', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/openapi.json'));
        expect(res.status).toBe(200);
        const doc = await res.json();
        expect(doc.openapi).toBe('3.0.0');
        expect(doc.info?.title).toBe('Antiphony Core API');

        const paths = Object.keys(doc.paths ?? {});
        // The canonical Antiphony surface: actor identity (/users, /resolve),
        // audio posts (/posts), and audio storage (/audio). When new routes
        // join the documented contract, spot-check them here.
        expect(paths).toContain('/api/v1/users');
        expect(paths).toContain('/api/v1/users/me');
        expect(paths).toContain('/api/v1/users/{handle}');
        expect(paths).toContain('/api/v1/users/{handle}/profile');
        expect(paths).toContain('/api/v1/resolve/{handle}');
        expect(paths).toContain('/api/v1/posts');
        expect(paths).toContain('/api/v1/posts/{postId}');
        expect(paths).toContain('/api/v1/posts/{postId}/replies');
        expect(paths).toContain('/api/v1/audio/upload');
        expect(paths).toContain('/api/v1/atproto/disconnect');
        // Legacy prompt/reply/org surface is gone.
        expect(paths).not.toContain('/api/v1/prompts');
        expect(paths).not.toContain('/api/v1/replies');
        expect(paths).not.toContain('/api/v1/organizations');
        expect(paths.length).toBeGreaterThanOrEqual(12);
    });

    it('describes authentication in info.description', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/openapi.json'));
        const doc = await res.json();
        expect(doc.info?.description).toMatch(/Authentication/);
        expect(doc.info?.description).toMatch(/Authorization: Bearer/);
        expect(doc.info?.description).toMatch(/Envelope/);
    });
});

describe('Security headers', () => {
    it('sends a strict API-tier CSP on JSON responses', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        const csp = res.headers.get('content-security-policy');
        expect(csp).toBeTruthy();
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("form-action 'none'");
    });

    it('denies framing and sets the hardening headers', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        // Cross-origin by design: same-origin would break cross-origin no-cors
        // loads (e.g. <audio> against the audio proxy). CORS still gates fetch.
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        expect(res.headers.get('permissions-policy')).toContain('microphone=()');
    });

    it('applies the headers to /api/v1/* routes too', async () => {
        // The middleware is global (`*`), so even an unmatched /api/v1/* path
        // (404) carries the headers — which is exactly what we want to assert:
        // the policy reaches the API surface, not just the root probes.
        const a = app();
        const res = await a.fetch(new Request('http://localhost/api/v1/nonexistent'));
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    });
});

describe('GET /health', () => {
    it('returns ok:true with sha and deployedAt fields', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(typeof body.sha).toBe('string');
        // deployedAt is null in dev (esbuild define not applied by tsx)
        expect('deployedAt' in body).toBe(true);
    });
});
