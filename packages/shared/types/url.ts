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
 * One fidelity note on that generated `pattern`: JSON Schema has no way to
 * express a case-insensitive regex, so `openapi.json` documents
 * `^https?:\/\/` without the `i` flag. `HTTPS://x` therefore passes here and
 * fails a strict reading of the document. Real URLs carry a lowercase scheme,
 * and the alternative — dropping `i` — would reject input for cosmetics, so the
 * runtime stays the more permissive of the two on that one axis.
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
            // The one audited bare `.url()` in the repo: this function IS the
            // replacement the rule points at, and the scheme anchor below is
            // what makes it safe. Every other call site is a bug.
            // eslint-disable-next-line antiphony/no-bare-zod-url
            .url()
            .regex(/^https?:\/\//i, { message: 'URL must use the http or https scheme' })
    );
}

// #endregion
