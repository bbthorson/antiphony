import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Locate this package by walking up from the cwd, rather than from
 * `import.meta.url`.
 *
 * Deliberate: this package typechecks under `module: commonjs` (see
 * `tsconfig.json`), where `import.meta` is a hard compile error — even though
 * vitest runs this file as ESM and would be perfectly happy with it. The
 * walk works under both, and also survives being run from the repo root or
 * from the package directory, which `npm test` and `npm run test --workspaces`
 * disagree about.
 */
const PKG_ROOT = (() => {
    let dir = process.cwd();
    for (;;) {
        if (existsSync(resolve(dir, 'packages/shared/tsup.config.ts'))) return resolve(dir, 'packages/shared');
        if (existsSync(resolve(dir, 'tsup.config.ts')) && existsSync(resolve(dir, 'index.ts'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('could not locate packages/shared from ' + process.cwd());
        dir = parent;
    }
})();

const read = (p: string) => readFileSync(resolve(PKG_ROOT, p), 'utf8');

/**
 * Packaging invariants for `@antiphony/shared`.
 *
 * The failure these exist to catch is quiet and only reachable from OUTSIDE the
 * repo, which is why nothing else caught it: `types/processing.ts` was exported
 * by `index.ts`, listed in the README's subpath table, and covered by the
 * `./types/*` wildcard in `exports` — but it was not a tsup entry, so no
 * no `dist` file for it was ever emitted and
 * `@antiphony/shared/types/processing` resolved to nothing for every consumer
 * of the published package. In-repo callers import `shared/types/processing`
 * through a tsconfig path alias to source, so the whole test suite, typecheck
 * and lint were green over a subpath that did not exist once published.
 *
 * These read the config files as text rather than importing them: tsup's config
 * is a `defineConfig` call and the package manifest is data, so a regex over
 * the source is both sufficient and immune to the build being stale.
 */

/** Relative module specifiers `index.ts` re-exports, as entry-style paths. */
function indexReExports(): string[] {
    return [...read('index.ts').matchAll(/export \* from '\.\/([^']+)'/g)].map(([, m]) => `${m}.ts`);
}

/** The `entry` array in `tsup.config.ts`. */
function tsupEntries(): string[] {
    const block = read('tsup.config.ts').match(/const entry = \[([\s\S]*?)\];/);
    if (!block) throw new Error('could not find the tsup `entry` array');
    return [...block[1].matchAll(/'([^']+)'/g)].map(([, m]) => m);
}

describe('tsup entries vs. the public surface', () => {
    it('emits a dist file for every module index.ts re-exports', () => {
        const entries = tsupEntries();
        // `errors`/`utils`/`observability` are directories re-exported as
        // `./errors`; their entry is the index file inside them.
        const missing = indexReExports().filter(
            (m) => !entries.includes(m) && !entries.includes(m.replace(/\.ts$/, '/index.ts')),
        );
        expect(missing, `not built, so their subpath resolves to nothing: ${missing.join(', ')}`).toEqual([]);
    });

    it('builds every type module the README advertises as a subpath', () => {
        const advertised = read('README.md').match(
            /`@antiphony\/shared\/types\/\*`[^|]*\|([^|]*)\|/,
        );
        expect(advertised, 'the README subpath table changed shape').toBeTruthy();
        const named = [...advertised![1].matchAll(/`(\w+)`/g)].map(([, m]) => `types/${m}.ts`);
        expect(named.length).toBeGreaterThan(0);
        expect(tsupEntries()).toEqual(expect.arrayContaining(named));
    });
});
