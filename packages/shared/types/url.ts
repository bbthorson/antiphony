import { z } from 'zod';

// #region URL schema helpers
// =================================================================================================

/**
 * Scheme-restricted URL schema: an absolute `http:`/`https:` URL, trimmed.
 *
 * ## Why this exists
 *
 * `z.string().url()` is `new URL()` under the hood, and `new URL()` accepts
 * ANY scheme. All of these parse clean through a bare `.url()`:
 *
 *     javascript:alert(1)
 *     data:text/html,<script>alert(1)</script>
 *     file:///etc/passwd
 *     vbscript:msgbox(1)
 *     blob:https://evil.example/x
 *
 * That is harmless for a value nobody dereferences and dangerous for one that
 * clients do. `AudioEmbedView.url` is the field a player puts in `<audio src>`;
 * `ActorProfileRecord.rssFeed` is the field an app renders as `<a href>`. A URL
 * that reaches either of those unchecked is a stored-XSS shape — written once,
 * fired for every viewer afterwards.
 *
 * So every URL field in this contract goes through this helper, and none of
 * them uses a bare `.url()`. The `antiphony/no-bare-zod-url` ESLint rule
 * enforces that, because "remember to use the helper" is not a control.
 *
 * ## Why `http:` is allowed, despite the name
 *
 * The name says https because https is what a deployment should serve; the rule
 * admits `http:` because a self-hosted or local Antiphony is reached at
 * `http://localhost:8787`, and `AudioEmbedView.url` is built from exactly that
 * base (`ANTIPHONY_PUBLIC_BASE_URL`). Excluding plain http would make the
 * contract unparseable in development for no safety gained: what this closes is
 * scheme confusion, not transport confidentiality. Transport is a deployment
 * concern, and the deployment that matters is https already.
 *
 * ## Why a string check and not a `.refine()`
 *
 * Two reasons, both practical:
 *
 *  - **It stays a `ZodString`.** A `.refine()` wraps the schema in `ZodEffects`,
 *    which costs consumers `.extend()`-friendliness and makes the OpenAPI
 *    generator emit a weaker schema. As a plain string check the constraint
 *    survives into `openapi.json` as a `pattern`, so a consumer in another
 *    language reads the rule instead of having to already know it.
 *  - **It is checked against the raw string, not a parsed `protocol`.** HTML
 *    strips tabs and newlines out of URL attributes before dereferencing them,
 *    so a scheme split by a tab is a live `javascript:` URL in a browser — and
 *    one `new URL()` parses happily. Requiring the string to LITERALLY begin
 *    `http://` or `https://` rejects that whole family without enumerating it.
 *
 * `.trim()` runs first so surrounding whitespace is normalised away rather than
 * sneaking a scheme past the anchor. It is a normalisation, not a loosening:
 * bare `.url()` accepted padded input too, it just kept the padding.
 *
 * ## Why the scheme is spelled `[Hh][Tt][Tt][Pp][Ss]?` and not `/…/i`
 *
 * The runtime check is case-insensitive on the scheme (`HTTPS://x` is a valid
 * URL and passes), but the regex carries no `i` flag. JSON Schema `pattern` has
 * no flag syntax, and with `/^https?:\/\//i` the OpenAPI generator serialized
 * the flag INTO the pattern string (`"^https?:\\/\\//i"`) — a pattern that
 * demands a literal `/i` after the scheme and so rejects every real URL for a
 * consumer validating against `openapi.json`. Spelling the case-insensitivity
 * out as character classes accepts exactly the same strings at runtime and
 * emits a pattern that means the same thing everywhere.
 * `apps/core-api/src/openapi-patterns.test.ts` fails if a flag leaks again.
 *
 * ## Why the check order matters
 *
 * In zod 4 every string format check (`.url()`, `.regex()`, `.email()`, …)
 * writes the schema's single `format` slot, and the LAST one wins. `.regex()`
 * claims it as `format: "regex"`, which the JSON Schema generator drops (the
 * regex is emitted as `pattern` instead). With `.url()` first, the regex
 * overwrote it and `openapi.json` lost `format: "uri"` on every URL field after
 * the zod 4 migration. With `.regex()` first, `.url()` keeps the slot and the
 * document carries both `format: "uri"` and the scheme `pattern`. Both checks
 * run either way, so the runtime behaviour is the same; `url.test.ts` asserts
 * the emitted JSON Schema so a reorder fails CI.
 *
 * Usage:
 *
 *     url:     httpsUrl()
 *     rssFeed: httpsUrl().optional()
 */
export function httpsUrl() {
    return (
        z
            .string()
            .trim()
            // `.regex()` BEFORE `.url()`: see "Why the check order matters" above.
            .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//, { message: 'URL must use the http or https scheme' })
            // The one audited bare `.url()` in the repo: this function IS the
            // replacement the rule points at, and the scheme anchor above is
            // what makes it safe. Every other call site is a bug.
            // eslint-disable-next-line antiphony/no-bare-zod-url
            .url()
    );
}

// #endregion
