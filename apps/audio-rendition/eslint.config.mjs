import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * ESLint config for `@antiphony/audio-rendition`.
 *
 * This service imports NOTHING from the rest of the monorepo — no
 * `@antiphony/core`, no `@antiphony/shared`, no core-api. That is deliberate and
 * enforced below: it is a separate deployable on a different runtime, reached
 * over HTTP, and the only contract between it and core-api is the `/render`
 * request shape. A shared type would make the two deploy in lockstep.
 *
 * The one visible cost is a duplicated constant-time compare and a duplicated
 * logger, both noted where they are.
 */
export default [
    {
        ignores: ["dist/", "node_modules/"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-restricted-imports": ["error", {
                patterns: [
                    {
                        group: ["@antiphony/*", "shared/*", "../../core-api/*"],
                        message:
                            "audio-rendition is a standalone deployable reached over HTTP. Its only contract with core-api is the /render request shape — sharing code would make the two deploy in lockstep.",
                    },
                ],
            }],
        },
    },
];
