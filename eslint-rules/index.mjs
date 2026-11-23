/**
 * antiphony local ESLint plugin.
 *
 * Houses repo-local lint rules that enforce conventions specific to this
 * codebase. Currently:
 *
 *   - `no-success-envelope-extras`: enforces the post-Phase-4 envelope
 *     contract on Hono `c.json(...)` calls — only `data` may accompany
 *     `success: true`. Enabled in `apps/core-api`.
 *   - `require-success-envelope`: the complement — requires inline
 *     `.json({ … })` route responses to BE an envelope (carry a `success`
 *     key) in the first place. Carried over from `apps/web`; not currently
 *     enabled in any workspace here.
 *   - `no-bare-zod-url`: forbids bare `z.string().url()` / `z.url()` in favour
 *     of the shared URL codecs so OpenAPI generation emits valid patterns.
 *     Enabled in `apps/core-api` and `packages/shared`.
 *   - `no-hardcoded-design-tokens`: forbids raw color values in favour of
 *     design system tokens (`--ap-*` / `--sl-*`). Enabled in `apps/docs`.
 *
 * Add new rules by importing them here and registering them in the
 * `rules` map below — the import path stays stable (`../../eslint-rules/`)
 * so consumer configs only update when adding NEW rules to enable.
 */

import noSuccessEnvelopeExtras from "./no-success-envelope-extras.mjs";
import requireSuccessEnvelope from "./require-success-envelope.mjs";
import noBareZodUrl from "./no-bare-zod-url.mjs";
import noHardcodedDesignTokens from "./no-hardcoded-design-tokens.mjs";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
    meta: { name: "antiphony" },
    rules: {
        "no-success-envelope-extras": noSuccessEnvelopeExtras,
        "require-success-envelope": requireSuccessEnvelope,
        "no-bare-zod-url": noBareZodUrl,
        "no-hardcoded-design-tokens": noHardcodedDesignTokens,
    },
};

export default plugin;
