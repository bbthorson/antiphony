import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for `@vox-pop/core`.
 *
 * Two invariants:
 *  - **Firebase-free**: this package must not import firebase / firebase-admin —
 *    Firebase bindings live in apps/web (or packages/hosted).
 *  - **Dependency direction** (Plan A, A6): packages are the platform
 *    foundation and must not import from any `apps/*`. Dependencies flow the
 *    other way — apps supply bindings that implement the interfaces core
 *    declares. See specs/decoupling-migration.md and
 *    specs/plan-a-core-api-contract.md.
 *
 * The invariant was previously enforced by grep during the Task E moves;
 * wiring it as a lint rule makes it editor-visible and CI-failing.
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
                        group: ["firebase", "firebase/*", "firebase-admin", "firebase-admin/*"],
                        message: "packages/core must not import firebase or firebase-admin — Firebase bindings live in apps/web (or packages/hosted). See specs/decoupling-migration.md."
                    },
                    {
                        // Dependency direction (Plan A, A6): no reaching "up"
                        // into any app. Covers relative paths, app workspace
                        // package names, and apps/web's `@/*` path alias.
                        group: [
                            "@/*",
                            "../../apps/**", "../apps/**", "**/apps/**",
                            "@vox-pop/web", "@vox-pop/web/*",
                            "@vox-pop/core-api", "@vox-pop/core-api/*",
                            "@vox-pop/relationships", "@vox-pop/relationships/*",
                            "@vox-pop/mobile", "@vox-pop/mobile/*",
                            "@vox-pop/embed", "@vox-pop/embed/*",
                            "@vox-pop/telephony", "@vox-pop/telephony/*",
                        ],
                        message: "packages/core must not import from apps/* — core is the platform foundation. Apps supply bindings that implement the interfaces core declares (CoreServices, *-dependencies). See specs/plan-a-core-api-contract.md (A6)."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
