import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['**/*.test.ts'],
        exclude: ['node_modules/**', 'dist/**'],
    },
    resolve: {
        alias: {
            // Mirror the tsconfig `paths` mapping so vitest resolves
            // `shared/*` imports the same way `tsc` does.
            'shared': new URL('../shared', import.meta.url).pathname,
        },
    },
});
