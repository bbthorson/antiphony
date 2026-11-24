import { defineConfig, type UserConfig } from 'tsdown';

const entry = ['index.ts', 'service-auth.ts', 'check-access.ts'];

const common: UserConfig = {
    entry,
    deps: { neverBundle: ['@antiphony/shared', /^@antiphony\/shared\//] },
    dts: true,
    sourcemap: false,
    treeshake: true,
    target: 'es2022',
    fixedExtension: false,
    clean: false,
    outputOptions: { strict: true },
};

export default defineConfig([
    { ...common, format: 'esm', outDir: 'dist/esm' },
    { ...common, format: 'cjs', outDir: 'dist/cjs' },
]);
