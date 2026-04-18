import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for `@vox-pop/core`.
 *
 * The central rule is the **Firebase-free invariant**: this package must not
 * import firebase, firebase-admin, or anything under `apps/web`. Dependencies
 * flow the other direction — apps/web supplies bindings that implement the
 * interfaces core declares. See specs/decoupling-migration.md.
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
                        group: ["@/*", "apps/web/*", "../../apps/**", "**/apps/web/**"],
                        message: "packages/core must not import from apps/web. Peer services reach through CoreServices; data access through *-dependencies interfaces."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
