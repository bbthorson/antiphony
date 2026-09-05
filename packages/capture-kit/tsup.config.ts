import { defineConfig, type Options } from 'tsup';

/**
 * Dual ESM/CJS build for `@antiphony/capture-kit`, mirroring
 * `@antiphony/shared`'s setup — see the longer rationale in its tsup.config.ts.
 * The short version: the source uses extensionless relative imports, which
 * `tsc`-emitted ESM cannot resolve at runtime, so esbuild resolves them at
 * build time instead.
 *
 * `react` and `react/jsx-runtime` stay EXTERNAL. Bundling React into a library
 * that declares it a peer dependency would ship a second copy into every
 * consumer, and two React instances in one tree is the "invalid hook call"
 * error — the exact failure the peer range exists to prevent.
 */
const entry = ['index.ts', 'waveform.ts'];

const common: Options = {
    entry,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    dts: true,
    sourcemap: false,
    treeshake: true,
    clean: false,
};

export default defineConfig([
    { ...common, format: ['esm'], outDir: 'dist/esm', splitting: true },
    { ...common, format: ['cjs'], outDir: 'dist/cjs', splitting: false },
]);
