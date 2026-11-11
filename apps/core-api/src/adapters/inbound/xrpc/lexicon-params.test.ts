import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import type { z } from 'zod';
import { GetPlaybackUrlQuerySchema, GetPostQuerySchema, GetThreadQuerySchema } from './index.js';
import { GetRemotePostsQuerySchema, ListRemotePostsQuerySchema } from '../remote-post-queries.js';

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
    format?: string;
    knownValues?: string[];
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    default?: unknown;
    items?: LexParam;
}

/** Sample values for the string formats a parameter declares. */
const SAMPLE_BY_FORMAT: Record<string, string> = {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    'at-uri': 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001',
};

/**
 * Parameters whose syntax the lexicon states only in prose, with a value the
 * handler's schema should accept. (Upstream has a `space-ref` format for a
 * space URI; the Lexicon validator here doesn't know it yet.)
 */
const SAMPLE_BY_PARAM: Record<string, string> = {
    'dev.antiphony.audio.listRemotePosts space': 'at://did:plc:group0000000000000000000/space/audio.voxpop.space.replies/3kprompt',
};

/** A query-string value the schema should accept for this parameter, and what it parses to. */
function sample(nsid: string, name: string, prop: LexParam): { raw: string | string[]; parsed: unknown } {
    if (prop.type === 'integer') {
        const raw = String(prop.minimum ?? 1);
        return { raw, parsed: Number(raw) };
    }
    if (prop.type === 'array') {
        const item = sample(nsid, name, prop.items ?? { type: 'string' });
        return { raw: [item.raw as string], parsed: [item.parsed] };
    }
    const raw = SAMPLE_BY_PARAM[`${nsid} ${name}`] ?? prop.knownValues?.[0] ?? (prop.format && SAMPLE_BY_FORMAT[prop.format]) ?? 'abc';
    return { raw, parsed: raw };
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
    'dev.antiphony.audio.listRemotePosts': ListRemotePostsQuerySchema,
    'dev.antiphony.audio.getRemotePosts': GetRemotePostsQuerySchema,
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
        const minimal: Record<string, string | string[]> = Object.fromEntries(
            [...required].map((name) => [name, sample(nsid, name, props[name]!).raw]),
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
                const value = sample(nsid, name, props[name]!);
                const parsed = schema.safeParse({ ...minimal, [name]: value.raw });
                expect(parsed.success, `${name} should parse`).toBe(true);
                expect(parsed.success && (parsed.data as Record<string, unknown>)[name], name).toEqual(value.parsed);
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

        it('refuses a value outside a declared format, known value set or array length', () => {
            for (const [name, prop] of Object.entries(props)) {
                const parse = (v: string | string[]) => schema.safeParse({ ...minimal, [name]: v });
                if (prop.type === 'string' && (prop.knownValues || (prop.format && SAMPLE_BY_FORMAT[prop.format]))) {
                    expect(parse('not a valid value').success, `${name} must be checked`).toBe(false);
                }
                if (prop.type === 'array' && prop.maxLength !== undefined) {
                    const item = sample(nsid, name, prop.items ?? { type: 'string' }).raw as string;
                    expect(parse(Array.from({ length: prop.maxLength }, () => item)).success, `${name} at its maximum`).toBe(true);
                    expect(parse(Array.from({ length: prop.maxLength + 1 }, () => item)).success, `${name} over its maximum`).toBe(false);
                }
            }
        });
    });
});
