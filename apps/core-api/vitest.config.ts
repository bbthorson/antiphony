import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
    resolve: {
        alias: {
            // Mirror tsconfig paths so vitest resolves workspace imports
            // the same way tsx does at runtime.
            'shared': new URL('../../packages/shared', import.meta.url).pathname,
            '@antiphony/core': new URL('../../packages/core', import.meta.url).pathname,
        },
    },
});
