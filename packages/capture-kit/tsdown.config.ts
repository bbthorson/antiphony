import { defineConfig, type UserConfig } from 'tsdown';

/**
 * Dual ESM/CJS build for `@antiphony/capture-kit`, mirroring
 * `@antiphony/shared`'s setup — see the longer rationale in its tsdown.config.ts.
 * The short version: the source uses extensionless relative imports, which
 * `tsc`-emitted ESM cannot resolve at runtime, so Rolldown resolves them at
 * build time instead.
 *
 * `react` and `react/jsx-runtime` stay EXTERNAL. Bundling React into a library
 * that declares it a peer dependency would ship a second copy into every
 * consumer, and two React instances in one tree is the "invalid hook call"
 * error — the exact failure the peer range exists to prevent.
 */
const entry = ['index.ts', 'waveform.ts', 'mime.ts'];

const common: UserConfig = {
    entry,
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime'] },
    dts: true,
    sourcemap: false,
    treeshake: true,
    // tsconfig.json's `target`, which tsup used implicitly; see shared.
    target: 'es2020',
    fixedExtension: false,
    clean: false,
    // Keeps `'use strict'` on the CJS output, as tsup emitted; see shared.
    outputOptions: { strict: true },
};

export default defineConfig([
    { ...common, format: 'esm', outDir: 'dist/esm' },
    { ...common, format: 'cjs', outDir: 'dist/cjs' },
]);
