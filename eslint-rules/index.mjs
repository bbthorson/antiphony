/**
 * vox-pop local ESLint plugin.
 *
 * Houses repo-local lint rules that enforce conventions specific to this
 * codebase. Currently:
 *
 *   - `no-success-envelope-extras`: enforces the post-Phase-4 envelope
 *     contract on Hono `c.json(...)` calls. See the rule file for details.
 *
 * Add new rules by importing them here and registering them in the
 * `rules` map below — the import path stays stable (`../../eslint-rules/`)
 * so consumer configs only update when adding NEW rules to enable.
 */

import noSuccessEnvelopeExtras from "./no-success-envelope-extras.mjs";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
    meta: { name: "vox-pop" },
    rules: {
        "no-success-envelope-extras": noSuccessEnvelopeExtras,
    },
};

export default plugin;
