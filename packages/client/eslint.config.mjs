import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
    {
        ignores: ['dist/', 'node_modules/'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [
                    {
                        group: [
                            '@/*',
                            '../../apps/**', '../apps/**', '**/apps/**',
                            '@antiphony/core', '@antiphony/core/*',
                            '@antiphony/core-api', '@antiphony/core-api/*',
                        ],
                        message: 'packages/client must only depend on @antiphony/shared, never on core or apps/*.',
                    },
                ],
            }],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        },
    },
];
