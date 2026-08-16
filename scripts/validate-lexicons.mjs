#!/usr/bin/env node
/**
 * Validates every document in `lexicons/` against the official AT Protocol
 * Lexicon specification, using upstream's own schema as the oracle.
 *
 * Three checks, in order:
 *
 *  1. **Spec conformance** — each file parses as JSON and validates against
 *     `lexiconDocumentSchema` from `@atproto/lex-document`. This is Bluesky's
 *     encoding of the Lexicon spec, so it moves when the spec moves; the point
 *     of using it rather than hand-rolling is that upstream drift shows up as
 *     a CI failure instead of a surprise at federation time.
 *  2. **Path/id agreement** — `lexicons/dev/antiphony/audio/post.json` must
 *     declare `dev.antiphony.audio.post`. Tooling (including upstream's
 *     `lex build`) resolves by path, so a mismatch is a silently broken ref.
 *  3. **Internal ref resolution** — every `dev.antiphony.*` and `#local` ref
 *     must point at a def that exists. Refs into other authorities
 *     (`app.bsky.*`, `com.atproto.*`) are reported but NOT resolved: doing so
 *     means vendoring ~20 third-party lexicon documents and putting a network
 *     fetch (or a CID-pinned manifest) in the CI path. That is a deliberate
 *     scope line — see specs/xrpc-and-atproto-lex-strategy.md §7 Phase 1.
 *
 * Run: `npm run test:lexicons`
 */

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { lexiconDocumentSchema } from '@atproto/lex-document';

/** Authority prefix this repo owns. Refs outside it are external. */
const OWNED_PREFIX = 'dev.antiphony.';

const failures = [];
const externalRefs = new Set();

const files = globSync('lexicons/**/*.json').sort();
if (files.length === 0) {
    console.error('✗ No lexicon documents found under lexicons/ — expected at least one.');
    process.exit(1);
}

/** @type {Map<string, { file: string, doc: object, defs: Set<string> }>} */
const index = new Map();

// --- Pass 1: parse, validate against the spec, index the defs ---------------

for (const file of files) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        failures.push(`${file}: not valid JSON — ${err.message}`);
        continue;
    }

    // `safeValidate`, not `safeParse` — the latter reports only the bare error
    // symbol ("InvalidRequest"), which says nothing about which field is wrong.
    const result = lexiconDocumentSchema.safeValidate(doc);
    if (!result.success) {
        failures.push(`${file}: does not conform to the Lexicon spec — ${result.message ?? result.error}`);
        // Fall through and index anyway: a doc can be spec-invalid in one field
        // and still be the legitimate target of refs from elsewhere. Dropping
        // it here would report every one of those refs as dangling and bury the
        // one real failure.
    }

    // `lexicons/dev/antiphony/audio/post.json` ⇒ `dev.antiphony.audio.post`
    const expectedId = relative('lexicons', file).replace(/\.json$/, '').split(sep).join('.');
    if (doc.id !== expectedId) {
        failures.push(`${file}: declares id "${doc.id}" but its path implies "${expectedId}".`);
    }

    if (typeof doc.id === 'string') {
        index.set(doc.id, { file, doc, defs: new Set(Object.keys(doc.defs ?? {})) });
    }
}

// --- Pass 2: resolve refs ---------------------------------------------------

for (const [id, { file, doc }] of index) {
    for (const ref of collectRefs(doc)) {
        const [target, def] = splitRef(ref, id);

        if (!target.startsWith(OWNED_PREFIX)) {
            externalRefs.add(ref);
            continue;
        }

        const entry = index.get(target);
        if (!entry) {
            failures.push(`${file}: ref "${ref}" points at ${target}, which has no document under lexicons/.`);
            continue;
        }
        if (!entry.defs.has(def)) {
            const known = [...entry.defs].join(', ');
            failures.push(`${file}: ref "${ref}" points at def "${def}" of ${target}, which defines only: ${known}.`);
        }
    }
}

// --- Report -----------------------------------------------------------------

if (externalRefs.size > 0) {
    console.log(`ℹ ${externalRefs.size} ref(s) into other authorities, not resolved here:`);
    for (const ref of [...externalRefs].sort()) console.log(`    ${ref}`);
    console.log('');
}

if (failures.length > 0) {
    console.error(`✗ ${failures.length} lexicon problem(s):\n`);
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
}

console.log(`✓ ${index.size} lexicon document(s) conform to the Lexicon spec, with all internal refs resolved.`);

// --- Helpers ----------------------------------------------------------------

/**
 * Every `ref` / `refs` value reachable in a lexicon document. Walks blindly
 * rather than following the type grammar, so a ref in a def shape this script
 * doesn't know about is still checked.
 *
 * @param {unknown} node
 * @returns {string[]}
 */
function collectRefs(node) {
    if (Array.isArray(node)) return node.flatMap(collectRefs);
    if (node === null || typeof node !== 'object') return [];

    const found = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'ref' && typeof value === 'string') found.push(value);
        else if (key === 'refs' && Array.isArray(value)) found.push(...value.filter((v) => typeof v === 'string'));
        else found.push(...collectRefs(value));
    }
    return found;
}

/**
 * Splits a ref into `[targetDocId, defName]`. A bare `#foo` is local to
 * `selfId`; a bare NSID means that document's `main` def.
 *
 * @param {string} ref
 * @param {string} selfId
 * @returns {[string, string]}
 */
function splitRef(ref, selfId) {
    if (ref.startsWith('#')) return [selfId, ref.slice(1)];
    const [target, def] = ref.split('#');
    return [target, def ?? 'main'];
}
