#!/usr/bin/env node
/**
 * Fails a PR that changes the API contract without bumping its version and
 * recording it in CHANGELOG.md.
 *
 * `apps/core-api/openapi.json` is the committed contract (ci.yml asserts it
 * matches the code). specs/api-versioning.md says every change to it bumps
 * `info.version` (minor for a break while 0.x, patch otherwise) and gets a
 * CHANGELOG entry. Nothing enforced that, and the apps pin `@antiphony/shared`
 * against these versions, so a silent contract change reaches them unannounced.
 *
 * Usage: node scripts/check-contract-version.mjs <base-sha>
 * Compares the base commit's spec with the working tree's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SPEC = 'apps/core-api/openapi.json';
const base = process.argv[2];
if (!base) {
    console.error('usage: check-contract-version.mjs <base-sha>');
    process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

let baseSpec;
try {
    baseSpec = JSON.parse(git('show', `${base}:${SPEC}`));
} catch {
    console.log(`${SPEC} does not exist at ${base}; nothing to compare.`);
    process.exit(0);
}
const headSpec = JSON.parse(readFileSync(SPEC, 'utf8'));

// The surface is everything except `info`, which carries the version itself.
const surface = ({ info, ...rest }) => JSON.stringify(rest);
const surfaceChanged = surface(baseSpec) !== surface(headSpec);
const from = baseSpec.info?.version;
const to = headSpec.info?.version;
const versionChanged = from !== to;
const changelogChanged = git('diff', '--name-only', base, '--', 'CHANGELOG.md').trim() !== '';

const errors = [];
if (surfaceChanged && !versionChanged) {
    errors.push(
        `The API contract changed but info.version is still ${to}. Bump it in ` +
            '`apps/core-api/src/lib/openapi-info.ts` (minor for a breaking change while 0.x, ' +
            'patch otherwise; specs/api-versioning.md) and regenerate with `npm run build`.',
    );
}
if ((surfaceChanged || versionChanged) && !changelogChanged) {
    errors.push('The API contract changed but CHANGELOG.md did not. Record the change there.');
}

if (errors.length > 0) {
    for (const e of errors) console.log(`::error file=${SPEC}::${e}`);
    process.exit(1);
}
console.log(
    surfaceChanged || versionChanged
        ? `Contract ${from} → ${to}, recorded in CHANGELOG.md.`
        : 'API contract unchanged.',
);
