import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for `@antiphony/core`.
 *
 * Two invariants:
 *  - **Firebase-free**: this package must not import firebase / firebase-admin.
 *    Nothing in the repo does any more — the Firestore/GCS bindings and the
 *    dependency are gone — so today this can only fire on a fresh install. It
 *    stays because the reason it was written is structural rather than about
 *    Firebase: this package is ports and domain logic, and a binding to any
 *    concrete store belongs in a deployment's outbound adapters.
 *  - **Dependency direction**: packages are the platform foundation and must
 *    not import from any `apps/*`. Dependencies flow the other way — apps
 *    supply bindings that implement the interfaces core declares.
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
                        message: "packages/core must not import firebase or firebase-admin — this package is ports and domain logic; store bindings live in a deployment's outbound adapters."
                    },
                    {
                        // Dependency direction: no reaching "up" into any app.
                        // Covers relative paths and app workspace package names.
                        group: [
                            "@/*",
                            "../../apps/**", "../apps/**", "**/apps/**",
                            "@antiphony/core-api", "@antiphony/core-api/*",
                        ],
                        message: "packages/core must not import from apps/* — core is the platform foundation. Apps supply bindings that implement the interfaces core declares (CoreServices, *-dependencies)."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
