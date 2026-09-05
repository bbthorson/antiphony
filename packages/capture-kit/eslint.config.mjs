import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for `@antiphony/capture-kit`.
 *
 * **Dependency direction**: like `@antiphony/shared`, this package sits at the
 * bottom of the graph and must not import from any `apps/*`. It additionally
 * must not import `@antiphony/shared` — the capture kit is browser primitives
 * with no knowledge of the protocol, and a dependency on the contract package
 * would drag the whole record/view tree into a bundle whose entire job is to
 * work a microphone. The one place the two touch is documented rather than
 * imported: `computeWaveform` returns 0–100 ints because that is what the
 * `dev.antiphony.embed.audio` lexicon's `waveform` field accepts.
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
                            "@antiphony/core-api", "@antiphony/core-api/*",
                            "@antiphony/shared", "@antiphony/shared/*",
                        ],
                        message: "packages/capture-kit must not import from apps/* or from @antiphony/shared — it is browser audio primitives with no protocol knowledge. See the note in eslint.config.mjs."
                    }
                ]
            }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
