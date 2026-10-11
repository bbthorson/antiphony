import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import type { z } from 'zod';
import { GetPlaybackUrlQuerySchema, GetPostQuerySchema, GetThreadQuerySchema } from './index.js';

/**
 * Each XRPC query's `parameters`, as its lexicon declares them, against the
 * Zod schema its handler parses the query string with. The record, view and
 * procedure-input shapes are compared in `@antiphony/shared`
 * (types/lexicon-parity.test.ts); these schemas live beside the handlers, so
 * they are compared here.
 *
 * Behavioural rather than introspective: each declared property is checked by
 * what the schema accepts and refuses (absent, the bounds, a non-integer, the
 * default), which holds whatever shape the Zod schema is built in.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

interface LexParam {
    type: string;
    minimum?: number;
    maximum?: number;
    default?: unknown;
}

interface QueryDef {
    type: string;
    parameters?: { required?: string[]; properties?: Record<string, LexParam> };
}

function queries(): Map<string, QueryDef> {
    const out = new Map<string, QueryDef>();
    for (const file of globSync('lexicons/dev/antiphony/**/*.json', { cwd: REPO_ROOT })) {
        const doc = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as { id: string; defs: Record<string, QueryDef> };
        const main = doc.defs.main;
        if (main?.type === 'query' && Object.keys(main.parameters?.properties ?? {}).length > 0) out.set(doc.id, main);
    }
    return out;
}

const SCHEMAS: Record<string, z.ZodTypeAny> = {
    'dev.antiphony.audio.getPost': GetPostQuerySchema,
    'dev.antiphony.audio.getThread': GetThreadQuerySchema,
    'dev.antiphony.audio.getPlaybackUrl': GetPlaybackUrlQuerySchema,
};

const QUERIES = queries();

describe('XRPC query parameters ↔ lexicon', () => {
    it('has a schema for every query that declares parameters, and none for one that does not', () => {
        expect([...QUERIES.keys()].sort()).toEqual(Object.keys(SCHEMAS).sort());
    });

    describe.each(Object.entries(SCHEMAS))('%s', (nsid, schema) => {
        const params = QUERIES.get(nsid)?.parameters;
        const props = params?.properties ?? {};
        const required = new Set(params?.required ?? []);
        /** A query string that satisfies every required parameter. */
        const minimal = Object.fromEntries(
            [...required].map((name) => [name, props[name]?.type === 'integer' ? String(props[name]!.minimum ?? 1) : 'x']),
        );
        const shapeKeys = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);

        it('declares the same parameters', () => {
            expect(shapeKeys.sort()).toEqual(Object.keys(props).sort());
        });

        it('accepts the minimal query, and refuses one missing any required parameter', () => {
            expect(schema.safeParse(minimal).success).toBe(true);
            for (const name of required) {
                const { [name]: _, ...without } = minimal;
                expect(schema.safeParse(without).success, `${name} should be required`).toBe(false);
            }
        });

        it('accepts each optional parameter and carries its value through', () => {
            for (const name of Object.keys(props).filter((n) => !required.has(n))) {
                const integer = props[name]!.type === 'integer';
                const value = integer ? String(props[name]!.minimum ?? 1) : 'abc';
                const parsed = schema.safeParse({ ...minimal, [name]: value });
                expect(parsed.success, `${name} should parse`).toBe(true);
                expect(parsed.success && (parsed.data as Record<string, unknown>)[name], name).toEqual(integer ? Number(value) : value);
            }
        });

        it('applies integer bounds and defaults as declared', () => {
            for (const [name, prop] of Object.entries(props)) {
                if (prop.type !== 'integer') continue;
                const parse = (v: string) => schema.safeParse({ ...minimal, [name]: v });
                expect(parse('1.5').success, `${name} must be an integer`).toBe(false);
                if (prop.minimum !== undefined) {
                    expect(parse(String(prop.minimum)).success, `${name} minimum`).toBe(true);
                    expect(parse(String(prop.minimum - 1)).success, `${name} below minimum`).toBe(false);
                }
                if (prop.maximum !== undefined) {
                    expect(parse(String(prop.maximum)).success, `${name} maximum`).toBe(true);
                    expect(parse(String(prop.maximum + 1)).success, `${name} above maximum`).toBe(false);
                }
                if (prop.default !== undefined) {
                    const { [name]: _, ...without } = minimal;
                    const parsed = schema.safeParse(without);
                    expect(parsed.success && (parsed.data as Record<string, unknown>)[name], `${name} default`).toBe(prop.default);
                }
            }
        });
    });
});
