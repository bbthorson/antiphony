/**
 * antiphony local ESLint plugin.
 *
 * Houses repo-local lint rules that enforce conventions specific to this
 * codebase. Currently:
 *
 *   - `no-success-envelope-extras`: enforces the post-Phase-4 envelope
 *     contract on Hono `c.json(...)` calls — only `data` may accompany
 *     `success: true`. See the rule file for details.
 *   - `require-success-envelope`: the complement — requires inline
 *     `.json({ … })` route responses to BE an envelope (carry a `success`
 *     key) in the first place. (Carried over; not currently enabled here.)
 *
 * Add new rules by importing them here and registering them in the
 * `rules` map below — the import path stays stable (`../../eslint-rules/`)
 * so consumer configs only update when adding NEW rules to enable.
 */

import noSuccessEnvelopeExtras from "./no-success-envelope-extras.mjs";
import requireSuccessEnvelope from "./require-success-envelope.mjs";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
    meta: { name: "antiphony" },
    rules: {
        "no-success-envelope-extras": noSuccessEnvelopeExtras,
        "require-success-envelope": requireSuccessEnvelope,
    },
};

export default plugin;
