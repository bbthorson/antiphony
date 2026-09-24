import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import antiphony from '../../eslint-rules/index.mjs';

/**
 * ESLint configuration for `@antiphony/docs`.
 * Enforces repository typescript standards and design token compliance.
 */
export default [
    { ignores: ['dist/', '.astro/', 'public/'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            antiphony,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            'antiphony/no-hardcoded-design-tokens': 'error',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
        },
    },
];
