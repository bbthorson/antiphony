import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import voxPop from "../../eslint-rules/index.mjs";

/**
 * ESLint config for `@vox-pop/core-api`.
 *
 * The central rule is the **dependency arrow invariant**: core-api must not
 * import from `apps/web/` or `apps/mobile/`. Once the `@vox-pop/core`
 * workspace dep is added (PR #2), core-api will import from core and shared
 * only. Firebase Admin is allowed — core-api is the Firebase-wired
 * deployment of core, and the no-Firebase rule lives on `packages/core/`
 * itself, not on the deployments that wire bindings.
 *
 * See specs/decoupling-migration.md § Phase 4.
 *
 * `vox-pop/no-success-envelope-extras` enforces the post-Phase-4 envelope
 * contract — only `data` is allowed alongside `success: true` in `c.json`
 * object literals. See `eslint-rules/no-success-envelope-extras.mjs`.
 */
export default [
    {
        ignores: ["dist/", "node_modules/"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            "vox-pop": voxPop,
        },
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-restricted-imports": ["error", {
                patterns: [
                    {
                        group: [
                            "@/*",
                            "apps/web/*",
                            "apps/mobile/*",
                            "../../apps/web/**",
                            "../../apps/mobile/**",
                        ],
                        message: "core-api must not import from apps/web or apps/mobile. Dependency arrow: clients → core ← hosted.",
                    },
                ],
            }],
            "vox-pop/no-success-envelope-extras": "error",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
];
