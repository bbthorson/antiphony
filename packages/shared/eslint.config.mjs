import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for `@vox-pop/shared`.
 *
 * **Dependency direction** (Plan A, A6): `@vox-pop/shared` is the contract
 * package at the bottom of the dependency graph — records, views, and the Zod
 * request/response codecs consumed by core-api, web, mobile, and functions. It
 * must not import from any `apps/*` (that would invert the graph and make the
 * contract depend on a consumer). Dependencies flow up *from* shared, never
 * down into it. See specs/plan-a-core-api-contract.md.
 */
export default [
    {
        ignores: ["dist/", "node_modules/"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "no-restricted-imports": ["error", {
                patterns: [
                    {
                        group: [
                            "@/*",
                            "../../apps/**", "../apps/**", "**/apps/**",
                            "@vox-pop/web", "@vox-pop/web/*",
                            "@vox-pop/core-api", "@vox-pop/core-api/*",
                            "@vox-pop/identity", "@vox-pop/identity/*",
                            "@vox-pop/mobile", "@vox-pop/mobile/*",
                            "@vox-pop/embed", "@vox-pop/embed/*",
                            "@vox-pop/telephony", "@vox-pop/telephony/*",
                        ],
                        message: "packages/shared must not import from apps/* — it is the contract package at the bottom of the dependency graph. See specs/plan-a-core-api-contract.md (A6)."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
