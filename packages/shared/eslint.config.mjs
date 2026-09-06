import js from "@eslint/js";
import tseslint from "typescript-eslint";
import antiphonyRules from "../../eslint-rules/index.mjs";

/**
 * ESLint config for `@antiphony/shared`.
 *
 * **Dependency direction**: `@antiphony/shared` is the contract package at
 * the bottom of the dependency graph — records, views, and the Zod
 * request/response codecs every other workspace consumes. It must not import
 * from any `apps/*` (that would invert the graph and make the contract depend
 * on a consumer). Dependencies flow up *from* shared, never down into it.
 *
 * `antiphony/no-bare-zod-url` is on here for the reason it exists: this is the
 * package whose `.url()` fields shipped to npm accepting `javascript:`. Every
 * URL in the contract goes through `httpsUrl()` (`types/url.ts`), which is the
 * single audited caller of bare `.url()` and disables the rule inline.
 */
export default [
    {
        ignores: ["dist/", "node_modules/"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            "antiphony": antiphonyRules,
        },
        rules: {
            "antiphony/no-bare-zod-url": "error",
            "no-restricted-imports": ["error", {
                patterns: [
                    {
                        group: [
                            "@/*",
                            "../../apps/**", "../apps/**", "**/apps/**",
                            "@antiphony/core-api", "@antiphony/core-api/*",
                        ],
                        message: "packages/shared must not import from apps/* — it is the contract package at the bottom of the dependency graph."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
