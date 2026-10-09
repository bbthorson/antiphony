import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { app } from './app.js';

/**
 * Every `pattern` in the OpenAPI document must be a valid, flag-free regex.
 *
 * JSON Schema `pattern` is a bare ECMA-262 regex source with no flag syntax. A
 * Zod `.regex(/…/i)` used to reach `openapi.json` as `"^https?:\\/\\//i"` — the
 * flag serialized into the pattern, so the published rule demanded a literal
 * `/i` after the scheme and rejected every real URL for any consumer validating
 * against the document. Nothing failed: the runtime check was fine, only the
 * documented one was wrong. This test makes that class of drift a CI failure,
 * against both the committed artifact and the live route declarations.
 */

/** A trailing `/` followed by only regex-flag letters, e.g. `…//i` or `…/gu`. */
const TRAILING_FLAGS = /\/[dgimsuvy]+$/;

function collectPatterns(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) {
        for (const item of node) collectPatterns(item, out);
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (key === 'pattern' && typeof value === 'string') out.push(value);
            else collectPatterns(value, out);
        }
    }
    return out;
}

function assertValidPatterns(doc: unknown): void {
    const patterns = collectPatterns(doc);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
        expect(pattern, `pattern ${JSON.stringify(pattern)} carries a serialized regex flag`).not.toMatch(
            TRAILING_FLAGS,
        );
        expect(() => new RegExp(pattern, 'u'), `pattern ${JSON.stringify(pattern)} is not a valid regex`).not.toThrow();
    }
}

describe('OpenAPI pattern hygiene', () => {
    it('the committed openapi.json has no flagged or invalid patterns', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const doc: unknown = JSON.parse(readFileSync(resolve(here, '..', 'openapi.json'), 'utf8'));
        assertValidPatterns(doc);
    });

    it('the live /openapi.json has no flagged or invalid patterns', async () => {
        const res = await app().fetch(new Request('http://localhost/openapi.json'));
        expect(res.ok).toBe(true);
        assertValidPatterns(await res.json());
    });
});
