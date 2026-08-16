import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
    ActorProfileRecordSchema,
    AudioEmbedSchema,
    AudioEmbedViewSchema,
    AudioPostRecordSchema,
    ReplyRefSchema,
    TimedTranscriptSchema,
    TranscriptEnrichmentRecordSchema,
    TranscriptSegmentSchema,
} from './audio';

/**
 * Oracle tests: the `lexicons/dev/antiphony/*.json` documents are the contract,
 * and these assert the Zod schemas in this package still match them.
 *
 * Why this exists: the lexicons and the Zod schemas are maintained by hand, in
 * two places, and nothing else compares them. Adding a field to one and
 * forgetting the other is silent — it surfaces as a field an atproto client can
 * send but the API rejects, or vice versa. This is the check that fails first.
 *
 * The lexicon is the source of truth in every assertion below. Where the Zod
 * schema legitimately diverges (storage-layer fields, `$type` discriminators,
 * the `labels` → `selfLabels` simplification), the divergence is declared in
 * the case's `extras` / `rename` and is therefore itself asserted: an
 * *undeclared* divergence fails, and a declared one that disappears from the
 * Zod schema also fails.
 *
 * Not compared: `maxGraphemes` (no Zod equivalent — grapheme counting is a
 * render-layer concern), `format` (Zod expresses some as `.url()`, others not
 * at all), and `description`.
 */

/**
 * Walks up from the working directory to the repo root — the one that owns
 * `lexicons/`. Not `import.meta.url`: this package compiles under
 * `module: commonjs` (it ships CJS as well as ESM), where `import.meta` is a
 * type error. Searching upward keeps this independent of where vitest is
 * invoked from, and throws rather than silently finding nothing.
 */
const REPO_ROOT = (() => {
    let dir = resolve(process.cwd());
    for (;;) {
        if (existsSync(join(dir, 'lexicons', 'dev', 'antiphony'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`No lexicons/dev/antiphony found above ${process.cwd()}`);
        dir = parent;
    }
})();

/** Reads a lexicon document by NSID. */
function lexicon(nsid: string): LexiconDoc {
    const path = join(REPO_ROOT, 'lexicons', ...nsid.split('.')) + '.json';
    return JSON.parse(readFileSync(path, 'utf8')) as LexiconDoc;
}

interface LexiconDoc {
    id: string;
    defs: Record<string, LexiconDef>;
}

interface LexiconDef {
    type: string;
    key?: string;
    /** Present on `type: "record"` defs — the object shape lives one level in. */
    record?: LexiconObject;
    required?: string[];
    properties?: Record<string, LexiconProperty>;
}

interface LexiconObject {
    type: 'object';
    required?: string[];
    properties?: Record<string, LexiconProperty>;
}

interface LexiconProperty {
    type: string;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    items?: LexiconProperty;
}

/** The object shape of a def, whether it's a bare object or a record wrapper. */
function objectOf(def: LexiconDef): LexiconObject {
    if (def.type === 'record') {
        if (!def.record) throw new Error('record def has no `record` shape');
        return def.record;
    }
    return def as unknown as LexiconObject;
}

// --- Zod introspection ------------------------------------------------------

/**
 * Strips the wrappers that don't change the shape — `.optional()`,
 * `.nullable()`, `.default()`, and the `ZodEffects` produced by `.refine()`.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
    let current = schema;
    for (;;) {
        const def = current._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
        if (def.typeName === 'ZodEffects' && def.schema) current = def.schema;
        else if (
            (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable' || def.typeName === 'ZodDefault') &&
            def.innerType
        ) {
            current = def.innerType;
        } else {
            return current;
        }
    }
}

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
    const unwrapped = unwrap(schema) as z.ZodObject<z.ZodRawShape>;
    if (typeof unwrapped.shape !== 'object') throw new Error('expected a ZodObject');
    return unwrapped.shape as Record<string, z.ZodTypeAny>;
}

/** The `max` check on a string or number, or the max length of an array. */
function maxOf(schema: z.ZodTypeAny): number | undefined {
    const inner = unwrap(schema);
    const def = inner._def as {
        typeName?: string;
        checks?: { kind: string; value: number }[];
        maxLength?: { value: number } | null;
    };
    if (def.typeName === 'ZodArray') return def.maxLength?.value;
    return def.checks?.find((c) => c.kind === 'max')?.value;
}

/** The `min` check on a number. */
function minOf(schema: z.ZodTypeAny): number | undefined {
    const def = unwrap(schema)._def as { checks?: { kind: string; value: number }[] };
    return def.checks?.find((c) => c.kind === 'min')?.value;
}

/** The element schema of an array. */
function elementOf(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
    const def = unwrap(schema)._def as { typeName?: string; type?: z.ZodTypeAny };
    return def.typeName === 'ZodArray' ? def.type : undefined;
}

// --- The cases --------------------------------------------------------------

interface ParityCase {
    /** Human label + the `nsid#def` the Zod schema mirrors. */
    lexicon: string;
    schema: z.ZodTypeAny;
    /**
     * Zod properties with no lexicon counterpart, each with the reason it is
     * absent from the public contract. Asserted to exist — a stale entry fails.
     */
    extras?: Record<string, string>;
    /** Lexicon property name → the Zod property name that carries it. */
    rename?: Record<string, string>;
    /** Lexicon properties deliberately not modeled in Zod, with the reason. */
    unmodeled?: Record<string, string>;
}

const STORAGE_FIELDS =
    'storage-layer field: indexed/denormalized for queries, deliberately outside the public lexicon and the record CID';

const CASES: ParityCase[] = [
    {
        lexicon: 'dev.antiphony.embed.audio#main',
        schema: AudioEmbedSchema,
        extras: { $type: 'union discriminator, carried on the wire but not a lexicon property' },
    },
    {
        lexicon: 'dev.antiphony.embed.audio#view',
        schema: AudioEmbedViewSchema,
        extras: {
            $type: 'union discriminator, carried on the wire but not a lexicon property',
            processing: 'per-stage processing status — a hosted-deployment concern, not part of the portable view',
        },
    },
    {
        lexicon: 'dev.antiphony.audio.post#main',
        schema: AudioPostRecordSchema,
        rename: { labels: 'selfLabels' },
        extras: {
            id: STORAGE_FIELDS,
            cid: STORAGE_FIELDS,
            originAppId: STORAGE_FIELDS,
            authorId: STORAGE_FIELDS,
            authorDid: STORAGE_FIELDS,
            orgId: STORAGE_FIELDS,
            kind: STORAGE_FIELDS,
            threadParticipants: STORAGE_FIELDS,
            rootAuthorId: STORAGE_FIELDS,
            processing: STORAGE_FIELDS,
        },
    },
    { lexicon: 'dev.antiphony.audio.post#replyRef', schema: ReplyRefSchema },
    {
        lexicon: 'dev.antiphony.audio.transcript#main',
        schema: TranscriptEnrichmentRecordSchema,
        extras: { id: STORAGE_FIELDS },
    },
    { lexicon: 'dev.antiphony.audio.transcript#timedTranscript', schema: TimedTranscriptSchema },
    { lexicon: 'dev.antiphony.audio.transcript#segment', schema: TranscriptSegmentSchema },
    { lexicon: 'dev.antiphony.actor.profile#main', schema: ActorProfileRecordSchema },
];

describe.each(CASES)('$lexicon ↔ Zod', (testCase) => {
    const [nsid, defName] = testCase.lexicon.split('#');
    const def = lexicon(nsid).defs[defName];
    const object = objectOf(def);
    const lexProps = object.properties ?? {};
    const lexRequired = new Set(object.required ?? []);
    const rename = testCase.rename ?? {};
    const extras = testCase.extras ?? {};
    const unmodeled = testCase.unmodeled ?? {};
    const shape = shapeOf(testCase.schema);

    /** The Zod property carrying a given lexicon property, if any. */
    const zodFor = (lexName: string) => shape[rename[lexName] ?? lexName];

    it('models every lexicon property', () => {
        const missing = Object.keys(lexProps).filter((name) => !zodFor(name) && !(name in unmodeled));
        expect(missing).toEqual([]);
    });

    it('declares every Zod property that the lexicon does not have', () => {
        const renamedTargets = new Set(Object.values(rename));
        const undeclared = Object.keys(shape).filter(
            (name) => !(name in lexProps) && !renamedTargets.has(name) && !(name in extras),
        );
        expect(undeclared).toEqual([]);
    });

    it('has no stale declared divergences', () => {
        // Every `extras` / `rename` / `unmodeled` entry must still describe
        // something real, so the declarations can't rot into a blanket exemption.
        expect(Object.keys(extras).filter((name) => !(name in shape))).toEqual([]);
        expect(Object.keys(rename).filter((name) => !(name in lexProps))).toEqual([]);
        expect(Object.values(rename).filter((name) => !(name in shape))).toEqual([]);
        expect(Object.keys(unmodeled).filter((name) => !(name in lexProps))).toEqual([]);
    });

    it('agrees on which properties are required', () => {
        const disagreements: string[] = [];
        for (const name of Object.keys(lexProps)) {
            const zodProp = zodFor(name);
            if (!zodProp) continue;
            const requiredInLexicon = lexRequired.has(name);
            const requiredInZod = !zodProp.isOptional();
            if (requiredInLexicon !== requiredInZod) {
                disagreements.push(
                    `${name}: lexicon says ${requiredInLexicon ? 'required' : 'optional'}, Zod says ${requiredInZod ? 'required' : 'optional'}`,
                );
            }
        }
        expect(disagreements).toEqual([]);
    });

    it('agrees on maxLength and integer bounds', () => {
        const disagreements: string[] = [];
        for (const [name, prop] of Object.entries(lexProps)) {
            const zodProp = zodFor(name);
            if (!zodProp) continue;

            if (prop.maxLength !== undefined && maxOf(zodProp) !== prop.maxLength) {
                disagreements.push(`${name}: lexicon maxLength ${prop.maxLength}, Zod max ${maxOf(zodProp)}`);
            }
            if (prop.type === 'integer') {
                if (prop.minimum !== undefined && minOf(zodProp) !== prop.minimum) {
                    disagreements.push(`${name}: lexicon minimum ${prop.minimum}, Zod min ${minOf(zodProp)}`);
                }
                if (prop.maximum !== undefined && maxOf(zodProp) !== prop.maximum) {
                    disagreements.push(`${name}: lexicon maximum ${prop.maximum}, Zod max ${maxOf(zodProp)}`);
                }
            }
            // Array element bounds (e.g. waveform peaks, normalized 0–100).
            const items = prop.items;
            const element = elementOf(zodProp);
            if (items?.type === 'integer' && element) {
                if (items.minimum !== undefined && minOf(element) !== items.minimum) {
                    disagreements.push(`${name}[]: lexicon minimum ${items.minimum}, Zod min ${minOf(element)}`);
                }
                if (items.maximum !== undefined && maxOf(element) !== items.maximum) {
                    disagreements.push(`${name}[]: lexicon maximum ${items.maximum}, Zod max ${maxOf(element)}`);
                }
            }
        }
        expect(disagreements).toEqual([]);
    });
});
