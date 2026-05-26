import { defineConfig, configDefaults } from 'vitest/config';

/**
 * Two reasons this file exists:
 *
 * 1. **Exclude `dist/**`** from test discovery. Without this, vitest tries to
 *    run any `*.test.js` files left in the build output as tests — and they
 *    fail with "Vitest cannot be imported in a CommonJS module" because the
 *    compiled output is CJS but vitest is ESM-only. The `dist/**` entry is
 *    defense-in-depth alongside the `tsconfig.build.json` `exclude` that
 *    keeps test files out of dist in the first place.
 * 2. **Enable globals** so the existing tests (which use `describe`/`it`/
 *    `expect` directly without importing them) keep working — same posture
 *    as `packages/core`.
 *
 * Uses `configDefaults.exclude` to preserve vitest's built-in excludes
 * (node_modules, .git, .cache, OS tmp dirs, etc.) instead of replacing
 * them — a plain `exclude: [...]` would clobber the defaults.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'dist/**'],
    },
});
