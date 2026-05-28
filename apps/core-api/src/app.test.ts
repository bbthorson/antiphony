import { describe, it, expect } from 'vitest';
import { app, parseAllowedOrigins } from './app.js';

describe('parseAllowedOrigins', () => {
    it('falls back to localhost dev port when env var is undefined', () => {
        expect(parseAllowedOrigins(undefined)).toEqual(['http://localhost:9002']);
    });

    it('falls back to localhost dev port when env var is an empty string', () => {
        expect(parseAllowedOrigins('')).toEqual(['http://localhost:9002']);
    });

    it('falls back to localhost dev port when env var is whitespace-only', () => {
        expect(parseAllowedOrigins('   ,  ,  ')).toEqual(['http://localhost:9002']);
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
        expect(doc.info?.title).toBe('Vox Pop Core API');

        const paths = Object.keys(doc.paths ?? {});
        // The toolchain pilot covers /users/*; expect every converted route
        // to appear. Subsequent PRs broaden this surface — when they land,
        // bump the expected count + spot-check additional paths here.
        expect(paths).toContain('/api/v1/users');
        expect(paths).toContain('/api/v1/users/me');
        expect(paths).toContain('/api/v1/users/{handle}');
        expect(paths).toContain('/api/v1/users/{handle}/prompts');
        expect(paths).toContain('/api/v1/users/switch-org');
        expect(paths).toContain('/api/v1/prompts');
        expect(paths).toContain('/api/v1/prompts/{promptId}');
        expect(paths).toContain('/api/v1/prompts/{promptId}/replies');
        expect(paths).toContain('/api/v1/prompts/public/{handle}/{promptId}');
        expect(paths.length).toBeGreaterThanOrEqual(18);
    });
});
