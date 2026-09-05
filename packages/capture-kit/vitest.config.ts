import { defineConfig, configDefaults } from 'vitest/config';

/**
 * `jsdom`, not `node` (which is what @antiphony/shared uses): everything in
 * this package touches a browser API — MediaRecorder, HTMLAudioElement,
 * AudioContext, URL.createObjectURL. jsdom does not implement any of the
 * *media* ones, so the suites stub them; what jsdom provides is the DOM,
 * `window`, and an event system real enough for React to render into.
 *
 * `exclude` extends `configDefaults.exclude` rather than replacing it, so
 * vitest's built-ins (node_modules, .git, cache dirs) survive — and `dist/**`
 * keeps built output from being discovered as tests.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['**/*.test.ts', '**/*.test.tsx'],
        exclude: [...configDefaults.exclude, 'dist/**'],
    },
});
