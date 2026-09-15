#!/usr/bin/env node
/**
 * Asserts that every dependency range declared in a `package.json` on disk is
 * actually satisfied by the version `package-lock.json` resolves for it.
 *
 * ── Why this is not already covered by `npm ci` ───────────────────────────────
 *
 * `npm ci` does check package.json against package-lock.json, and for the
 * obvious break it is enough: bump a range, leave the lockfile alone, and it
 * refuses with `EUSAGE … can only install packages when your package.json and
 * package-lock.json are in sync`. That case needs no guard.
 *
 * What it compares, though, is the manifest MIRROR the lockfile keeps of each
 * workspace — `packages["apps/docs"].devDependencies` and friends — not the
 * versions the lockfile actually resolves. `npm install` rewrites that mirror
 * happily while leaving a nested resolution in place that no longer satisfies
 * the range beside it, and from then on both commands are silent. Verified by
 * replaying the real case this repo hit (0e9d332 + `apps/docs` typescript
 * moved from `^7.0.2` to `^5.7.2`):
 *
 *     declared:  ^5.7.2
 *     installed: 7.0.2   ← apps/docs/node_modules/typescript
 *     npm install → exit 0        npm ci → exit 0
 *
 * So the tree installs cleanly, every test passes, and the declaration is a
 * statement about the tree that is simply false. That is the gap this closes.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 *
 *  1. Every declared range resolves to SOMETHING in the lockfile.
 *  2. The resolved version satisfies the declared range.
 *
 * Resolution walks up through nested `node_modules` exactly as Node does, so a
 * nested copy shadowing the hoisted one is compared against the range of the
 * workspace it is nested under — which is the whole point, since that is
 * precisely where the mirror and the tree can disagree.
 *
 * ── What it deliberately does not check ──────────────────────────────────────
 *
 * `peerDependencies` are skipped: they are a constraint on the CONSUMER's tree,
 * not a promise that this install contains them, and npm does not enforce them
 * on `npm ci` at all. That is not a gap this guard can close honestly — the
 * zod-4 investigation (#148) turned up `@hono/zod-openapi` declaring
 * `zod: >=3.0.0` while its own dependency needs `^3.20.2`, and no lockfile
 * check can see through a peer range that is simply wrong.
 *
 * Non-registry specifiers (`workspace:`, `file:`, `link:`, `npm:` aliases, git
 * and http URLs) and the bare `*` are skipped: there is no version range to
 * satisfy. Workspace cross-links resolve to lockfile entries marked `link`,
 * which are symlinks into the repo and carry no version of their own.
 *
 * Run: `npm run test:dependency-ranges` (also runs as part of `npm test`).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';

const root = process.cwd();
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Resolve `name` from `dir` the way Node does — nearest `node_modules` first,
 * then up to the root. Returns the lockfile entry, or null if nothing matches.
 *
 * @param {string} dir  Workspace directory, repo-relative; '' for the root.
 * @param {string} name
 */
function resolveFrom(dir, name) {
    const parts = dir === '' ? [] : dir.split('/');
    for (;;) {
        const key = [...parts, 'node_modules', name].join('/');
        if (lock.packages[key]) return { key, entry: lock.packages[key] };
        if (parts.length === 0) return null;
        parts.pop();
    }
}

/** Ranges with no version to satisfy — nothing to assert. */
function isUncheckable(range) {
    return range === '*' || range === '' || /^(workspace:|file:|link:|npm:|git|github:|https?:)/.test(range);
}

// Workspace directories come from the ON-DISK root manifest. Reading them from
// the lockfile instead would mean asking the lockfile to describe itself, which
// is exactly the mirror this guard exists not to trust.
const dirs = [''];
for (const pattern of rootManifest.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '');
    if (!existsSync(join(root, base))) continue;
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, base, entry.name, 'package.json'))) {
            dirs.push(`${base}/${entry.name}`);
        }
    }
}

const failures = [];
let checked = 0;

for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const label = dir === '' ? 'package.json' : `${dir}/package.json`;

    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
            if (isUncheckable(range)) continue;
            checked++;

            const found = resolveFrom(dir, name);
            if (!found) {
                failures.push(`${label} declares ${field}.${name}@${range}, which package-lock.json resolves to nothing.`);
                continue;
            }
            // A `link` entry is a symlinked workspace; it carries no version.
            if (found.entry.link || !found.entry.version) continue;

            if (!semver.satisfies(found.entry.version, range, { includePrerelease: true })) {
                failures.push(
                    `${label} declares ${field}.${name}@${range}, but package-lock.json installs ` +
                        `${found.entry.version} at ${found.key}.`,
                );
            }
        }
    }
}

if (failures.length > 0) {
    console.error(`✗ ${failures.length} dependency range(s) not satisfied by package-lock.json:\n`);
    for (const f of failures) console.error(`  • ${f}`);
    console.error('\n  Regenerate the lockfile (`npm install`) and commit it alongside the range change.');
    console.error('  If a nested copy is shadowing the hoisted one, `npm dedupe` clears it — but check');
    console.error('  its diff before committing: it also upgrades unrelated transitive packages.');
    process.exit(1);
}

console.log(`✓ ${checked} declared dependency ranges across ${dirs.length} manifests are satisfied by package-lock.json.`);
