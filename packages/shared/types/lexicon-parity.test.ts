import { describe, it, expect } from 'vitest';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
    ActorProfileRecordSchema,
    AudioEmbedSchema,
    AudioEmbedViewSchema,
    AudioPostRecordSchema,
    AudioPostViewSchema,
    PostRecordPublicSchema,
    ReplyRefSchema,
    TimedTranscriptSchema,
    TranscriptEnrichmentRecordSchema,
    TranscriptSegmentSchema,
    ViewerStateSchema,
} from './audio';
import { ProcessingRequestSchema } from './processing';
import { SpaceKeySchema } from './spaces';
import { CreateAudioPostRequestSchema, PatchAudioPostRequestSchema } from '../api-codecs';

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
    /** Present on `procedure` defs. */
    input?: { schema?: LexiconObject | { type: 'ref' } };
    /** Present on `query` and `procedure` defs. */
    output?: { schema?: LexiconObject | { type: 'ref' } };
    /** Present on `query` defs (`type: "params"`). */
    parameters?: LexiconObject;
    required?: string[];
    properties?: Record<string, LexiconProperty>;
}

interface LexiconObject {
    type: 'object' | 'params';
    required?: string[];
    properties?: Record<string, LexiconProperty>;
}

interface LexiconProperty {
    type: string;
    format?: string;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    items?: LexiconProperty;
}

/** Which shape of a def a case compares: the def itself, or a method's input, output or parameters. */
type DefPart = 'input' | 'output' | 'parameters';

/** The object shape of a def: a bare object, a record's, or one part of a method. */
function objectOf(def: LexiconDef, part?: DefPart): LexiconObject {
    if (part) {
        const shape = part === 'parameters' ? def.parameters : def[part]?.schema;
        if (!shape || shape.type === 'ref') throw new Error(`def has no inline ${part} object`);
        return shape as LexiconObject;
    }
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
interface ZodDefInspection {
    type?: string;
    typeName?: string;
    schema?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    element?: z.ZodTypeAny;
    checks?: Array<Record<string, unknown> & { _zod?: { def?: Record<string, unknown> } }>;
    maxLength?: { value: number };
}

interface ZodCheckInspection {
    check?: string;
    kind?: string;
    maximum?: number;
    value?: number;
}

function getDef(schema: z.ZodTypeAny): ZodDefInspection | undefined {
    return (schema as unknown as { _def?: ZodDefInspection })._def;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
    let current = schema;
    for (;;) {
        const def = getDef(current);
        if (!def) return current;
        if (def.schema) {
            current = def.schema;
        } else if (def.innerType) {
            current = def.innerType;
        } else {
            return current;
        }
    }
}

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
    const unwrapped = unwrap(schema) as unknown as { shape?: Record<string, z.ZodTypeAny> };
    if (!unwrapped.shape || typeof unwrapped.shape !== 'object') throw new Error('expected a ZodObject');
    return unwrapped.shape;
}

function getChecks(schema: z.ZodTypeAny): ZodCheckInspection[] {
    const unwrapped = unwrap(schema);
    const def = getDef(unwrapped);
    if (!def?.checks) return [];
    return def.checks.map((c) => (c._zod?.def ?? c) as ZodCheckInspection);
}

/** The `max` check on a string or number, or the max length of an array. */
function maxOf(schema: z.ZodTypeAny): number | undefined {
    const unwrapped = unwrap(schema);
    const def = getDef(unwrapped);
    if (def?.typeName === 'ZodArray') return def.maxLength?.value;
    const checks = getChecks(schema);
    const maxCheck = checks.find((c) => c.check === 'max_length' || c.check === 'less_than' || c.kind === 'max');
    if (maxCheck) return maxCheck.maximum ?? maxCheck.value;
    return undefined;
}

/** The `min` check on a number. */
function minOf(schema: z.ZodTypeAny): number | undefined {
    const checks = getChecks(schema);
    const minCheck = checks.find((c) => c.check === 'greater_than' || c.kind === 'min');
    if (minCheck) return minCheck.value;
    return undefined;
}

/**
 * Whether a schema carries a `.default()` — i.e. it is optional on input but
 * always present on output. Checked before unwrapping, since unwrapping is
 * exactly what discards the `ZodDefault` this is looking for.
 */
function hasDefault(schema: z.ZodTypeAny | undefined): boolean {
    if (!schema) return false;
    const def = getDef(schema);
    return def?.type === 'default' || def?.typeName === 'ZodDefault';
}

/** The element schema of an array. */
function elementOf(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
    const unwrapped = unwrap(schema);
    const def = getDef(unwrapped);
    if (def?.typeName === 'ZodArray') return (def as { type?: z.ZodTypeAny }).type;
    if (def?.type === 'array') return def.element;
    return undefined;
}

/**
 * The Zod kind a lexicon type must map to, or undefined when the lexicon type
 * has no single Zod counterpart to compare (`ref`, `union`, `blob`, `unknown`,
 * `cid-link`, `bytes`: those are compared through their own cases, or not at
 * all).
 */
const ZOD_KINDS_FOR: Record<string, string[]> = {
    string: ['string', 'enum', 'literal', 'ZodString', 'ZodEnum', 'ZodLiteral'],
    integer: ['number', 'int', 'ZodNumber'],
    boolean: ['boolean', 'ZodBoolean'],
    array: ['array', 'ZodArray'],
    object: ['object', 'ZodObject'],
};

/** A schema's kind after unwrapping: Zod 4's `def.type`, or Zod 3's `typeName`. */
function kindOf(schema: z.ZodTypeAny): string | undefined {
    const def = getDef(unwrap(schema));
    return (typeof def?.type === 'string' ? def.type : undefined) ?? def?.typeName;
}

// --- The cases --------------------------------------------------------------

interface ParityCase {
    /** Human label + the `nsid#def` the Zod schema mirrors. */
    lexicon: string;
    /** For a method def: which part the schema mirrors. */
    part?: DefPart;
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
    /**
     * Properties the lexicon requires whose Zod counterpart reads as optional
     * because it carries a `.default()`.
     *
     * This is a genuine mismatch in what "required" means on each side, not a
     * loophole: Zod's optionality here describes what a caller may OMIT ON
     * INPUT, while the lexicon describes what the server always EMITS. A
     * defaulted boolean is absent from no response. Listing one asserts it
     * really is defaulted — a plain `.optional()` would not satisfy this.
     */
    defaulted?: Record<string, string>;
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
            space: STORAGE_FIELDS,
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

    // The XRPC view and request shapes (specs/xrpc-and-atproto-lex-strategy.md
    // §7 Phase 2). These are read-time and request-time types rather than
    // records — nothing here is stored or enters a record CID — but they are
    // the contract the `/xrpc/*` surface publishes, so they drift exactly the
    // same way the record types do.
    {
        lexicon: 'dev.antiphony.audio.defs#postView',
        schema: AudioPostViewSchema,
    },
    {
        lexicon: 'dev.antiphony.audio.defs#postRecord',
        schema: PostRecordPublicSchema,
    },
    {
        lexicon: 'dev.antiphony.audio.defs#viewerState',
        schema: ViewerStateSchema,
        defaulted: {
            isAuthor: 'defaults to false; the server emits it on every view',
            canReply: 'defaults to false; the server emits it on every view',
        },
    },
    {
        lexicon: 'dev.antiphony.audio.defs#processingRequest',
        schema: ProcessingRequestSchema,
    },
    { lexicon: 'dev.antiphony.audio.defs#spaceKey', schema: SpaceKeySchema },

    // Procedure inputs: the body each XRPC procedure validates with.
    {
        lexicon: 'dev.antiphony.audio.createPost#main',
        part: 'input',
        schema: CreateAudioPostRequestSchema,
    },
    {
        lexicon: 'dev.antiphony.audio.reprocessPost#main',
        part: 'input',
        schema: PatchAudioPostRequestSchema,
        unmodeled: {
            id: 'REST carries the post id in the path; the XRPC handler extends this schema with it (apps/core-api/src/adapters/inbound/xrpc/index.ts, ReprocessBodySchema)',
        },
    },
];

describe.each(CASES)('$lexicon $part ↔ Zod', (testCase) => {
    const [nsid, defName] = testCase.lexicon.split('#');
    const def = lexicon(nsid).defs[defName];
    const object = objectOf(def, testCase.part);
    const lexProps = object.properties ?? {};
    const lexRequired = new Set(object.required ?? []);
    const rename = testCase.rename ?? {};
    const extras = testCase.extras ?? {};
    const unmodeled = testCase.unmodeled ?? {};
    const defaulted = testCase.defaulted ?? {};
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
        // Every `extras` / `rename` / `unmodeled` / `defaulted` entry must still
        // describe something real, so the declarations can't rot into a blanket
        // exemption.
        expect(Object.keys(extras).filter((name) => !(name in shape))).toEqual([]);
        expect(Object.keys(rename).filter((name) => !(name in lexProps))).toEqual([]);
        expect(Object.values(rename).filter((name) => !(name in shape))).toEqual([]);
        expect(Object.keys(unmodeled).filter((name) => !(name in lexProps))).toEqual([]);
        // A `defaulted` entry must name a property the lexicon requires AND
        // whose Zod counterpart genuinely carries a default — a plain
        // `.optional()` is a real disagreement, not this exemption.
        expect(
            Object.keys(defaulted).filter(
                (name) => !lexRequired.has(name) || !hasDefault(zodFor(name)),
            ),
        ).toEqual([]);
    });

    it('agrees on which properties are required', () => {
        const disagreements: string[] = [];
        for (const name of Object.keys(lexProps)) {
            const zodProp = zodFor(name);
            if (!zodProp) continue;
            const requiredInLexicon = lexRequired.has(name);
            // A defaulted property is input-optional but always emitted; the
            // declaration above asserts that reading is accurate.
            const requiredInZod = !zodProp.isOptional() || name in defaulted;
            if (requiredInLexicon !== requiredInZod) {
                disagreements.push(
                    `${name}: lexicon says ${requiredInLexicon ? 'required' : 'optional'}, Zod says ${requiredInZod ? 'required' : 'optional'}`,
                );
            }
        }
        expect(disagreements).toEqual([]);
    });

    it('agrees on property types', () => {
        const disagreements: string[] = [];
        for (const [name, prop] of Object.entries(lexProps)) {
            const zodProp = zodFor(name);
            // A `datetime` string is parsed into a `Date` on the Zod side
            // (TimestampSchema), which reads as a pipe, not a string.
            const expected = prop.type === 'string' && prop.format === 'datetime'
                ? [...ZOD_KINDS_FOR.string!, 'pipe', 'date', 'ZodEffects', 'ZodDate']
                : ZOD_KINDS_FOR[prop.type];
            if (!zodProp || !expected) continue;
            const kind = kindOf(zodProp);
            if (!kind || !expected.includes(kind)) {
                disagreements.push(`${name}: lexicon ${prop.type}, Zod ${kind}`);
            }
            const items = prop.items;
            const element = elementOf(zodProp);
            const expectedItem = items && ZOD_KINDS_FOR[items.type];
            if (expectedItem && element && !expectedItem.includes(kindOf(element) ?? '')) {
                disagreements.push(`${name}[]: lexicon ${items.type}, Zod ${kindOf(element)}`);
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

/**
 * Every shape a lexicon in `lexicons/dev/antiphony/` defines is compared above,
 * or listed here with the reason it is not. Without this, a lexicon or a part
 * of one that no case names drifts silently: the parity cases only ever check
 * what someone remembered to add.
 *
 * A method part whose schema is a `ref` (an output that is `defs#postView`, say)
 * is compared through the def it names, so it is not listed.
 */
const PARAMS_ELSEWHERE =
    'query parameters are validated by schemas in core-api, and compared there (apps/core-api/src/adapters/inbound/xrpc/lexicon-params.test.ts)';

const NOT_COMPARED: Record<string, string> = {
    'dev.antiphony.audio.createPost#main:output':
        'the StrongRef `{ uri, cid }` the handler builds from the created record; no Zod schema (xrpc/index.test.ts asserts it)',
    'dev.antiphony.audio.getPost#main:parameters': PARAMS_ELSEWHERE,
    'dev.antiphony.audio.getThread#main:parameters': PARAMS_ELSEWHERE,
    'dev.antiphony.audio.getPlaybackUrl#main:parameters': PARAMS_ELSEWHERE,
    'dev.antiphony.audio.getThread#main:output':
        '`{ parent, replies, cursor }` assembled by the handler; parent and replies are defs#postView, compared above',
    'dev.antiphony.audio.getPlaybackUrl#main:output': '`{ url }` built by the handler; no Zod schema',
    'dev.antiphony.embed.recordWithAudio#main': 'no API path accepts or emits it yet, so no Zod schema exists to compare',
    'dev.antiphony.embed.recordWithAudio#view': 'no API path accepts or emits it yet, so no Zod schema exists to compare',
};

describe('lexicon coverage', () => {
    /** Every comparable shape: `nsid#def` for objects and records, `nsid#def:part` for methods. */
    const shapes = globSync('lexicons/dev/antiphony/**/*.json', { cwd: REPO_ROOT }).flatMap((file) => {
        const doc = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as LexiconDoc;
        return Object.entries(doc.defs).flatMap(([name, def]) => {
            const id = `${doc.id}#${name}`;
            if (def.type === 'object' || def.type === 'record') return [id];
            const parts: string[] = [];
            if (def.parameters?.properties && Object.keys(def.parameters.properties).length > 0) parts.push(`${id}:parameters`);
            for (const part of ['input', 'output'] as const) {
                const shape = def[part]?.schema;
                if (shape && shape.type !== 'ref') parts.push(`${id}:${part}`);
            }
            return parts;
        });
    });
    const compared = new Set(CASES.map((c) => (c.part ? `${c.lexicon}:${c.part}` : c.lexicon)));

    it('finds the lexicons', () => {
        expect(shapes.length).toBeGreaterThan(10);
    });

    it('compares or explicitly exempts every shape a lexicon defines', () => {
        expect(shapes.filter((s) => !compared.has(s) && !(s in NOT_COMPARED))).toEqual([]);
    });

    it('has no stale exemptions', () => {
        const all = new Set(shapes);
        expect(Object.keys(NOT_COMPARED).filter((s) => !all.has(s) || compared.has(s))).toEqual([]);
    });
});
