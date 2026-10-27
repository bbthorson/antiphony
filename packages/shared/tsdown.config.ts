import { defineConfig, type UserConfig } from 'tsdown';

/**
 * Dual ESM/CJS build for `@antiphony/shared`.
 *
 * Why a bundler instead of plain `tsc`: the source uses *extensionless*
 * relative imports (`from './types/records'`). Node's ESM resolver requires
 * explicit extensions, which `tsc` does not add — so a tsc-emitted ESM build
 * is broken at runtime. Rolldown (via tsdown) resolves the imports at build
 * time, producing working ESM and CJS.
 *
 * Output layout — two sibling trees with explicit, self-describing extensions
 * (no `package.json` `type` markers needed):
 *   dist/esm/  → `.js`  + `.d.ts`   ESM (ESM under the root `"type": "module"`);
 *               consumed via the `import` condition (external consumers).
 *   dist/cjs/  → `.cjs` + `.d.cts`  CommonJS (the extension forces CJS
 *               regardless of the root `type`); consumed via `require`
 *               (`functions` depends on this). This is what retires the old
 *               `dist/package.json {"type":"commonjs"}` marker hack.
 *
 * `zod` stays external so there is a single zod module instance across the
 * ESM/CJS boundary — without that, `@hono/zod-openapi`'s `.openapi()`
 * extension never reaches schemas defined here (the dual-package hazard this
 * whole setup exists to avoid).
 */
const entry = [
  'index.ts',
  'api-codecs.ts',
  'nsid.ts',
  'errors/index.ts',
  'utils/index.ts',
  'observability/index.ts',
  'observability/report-error.ts',
  'types/audio.ts',
  'types/blob.ts',
  'types/deletion.ts',
  // `types/processing.ts` is an entry for the same reason the others are: the
  // package `exports` map advertises a `./types/*` wildcard, so
  // `@antiphony/shared/types/processing` is a subpath consumers can write — and
  // until this line existed it resolved to nothing, because the bundler only
  // emits dist files for entries. The module was reachable only by importing
  // the root `index`, which pulls in api-codecs, errors, utils and
  // observability to get at four stage names. Every module `index.ts`
  // re-exports belongs here.
  'types/processing.ts',
  'types/records.ts',
  'types/spaces.ts',
  'types/url.ts',
];

const common: UserConfig = {
  entry,
  deps: { neverBundle: ['zod'] },
  dts: true,
  sourcemap: false,
  treeshake: true,
  // tsup took its syntax target from tsconfig.json's `target`; tsdown takes it
  // from `engines.node`, and this package declares none, so without this line
  // the output would stop being downleveled at all.
  target: 'es2016',
  // `.js`/`.d.ts` for ESM, `.cjs`/`.d.cts` for CJS (CJS is disambiguated by
  // extension because the root is `"type": "module"`). tsdown defaults to
  // `.mjs`/`.d.mts` for ESM on the node platform; `false` keeps `.js`, which
  // is what the `exports` map points at. `clean` is handled by the build
  // script wiping `dist/` first, so neither config clobbers the other's
  // output.
  fixedExtension: false,
  clean: false,
  // tsup's CJS output opened with `'use strict'`. Rolldown's default (`auto`)
  // only repeats directives found in the source, and the source has none, so
  // the CJS files would silently run in sloppy mode. ESM is strict regardless.
  outputOptions: { strict: true },
};

export default defineConfig([
  // Both formats code-split: shared modules (e.g. types re-exported by index)
  // are factored into chunks, so the same schema instance is reused across
  // entry points instead of duplicated. zod stays external either way, so the
  // zod module itself is shared with the consumer.
  { ...common, format: 'esm', outDir: 'dist/esm' },
  { ...common, format: 'cjs', outDir: 'dist/cjs' },
]);
