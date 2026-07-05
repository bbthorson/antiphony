import { defineConfig, type Options } from 'tsup';

/**
 * Dual ESM/CJS build for `@antiphony/shared`.
 *
 * Why a bundler instead of plain `tsc`: the source uses *extensionless*
 * relative imports (`from './types/records'`). Node's ESM resolver requires
 * explicit extensions, which `tsc` does not add — so a tsc-emitted ESM build
 * is broken at runtime. esbuild (via tsup) resolves the imports at build time,
 * producing working ESM and CJS.
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
  'types/records.ts',
];

const common: Options = {
  entry,
  external: ['zod'],
  dts: true,
  sourcemap: false,
  treeshake: true,
  // Natural extensions: `.js`/`.d.ts` for ESM, `.cjs`/`.d.cts` for CJS (tsup
  // disambiguates CJS by extension because the root is `"type": "module"`).
  // The `.cjs` extension is what retires the old `dist/package.json` type
  // marker. `clean` is handled by the build script wiping `dist/` first, so
  // neither config clobbers the other's output.
  clean: false,
};

export default defineConfig([
  // ESM: splitting factors the shared modules (e.g. types re-exported by
  // index) into chunks, so the same schema instance is reused across entry
  // points instead of duplicated.
  { ...common, format: ['esm'], outDir: 'dist/esm', splitting: true },
  // CJS: esbuild can't code-split CJS; each entry is self-contained. zod stays
  // external, so cross-entry schema duplication is harmless (no identity-based
  // comparisons; the zod module itself is shared).
  { ...common, format: ['cjs'], outDir: 'dist/cjs', splitting: false },
]);
