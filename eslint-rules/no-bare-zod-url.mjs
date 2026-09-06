/**
 * ESLint rule: antiphony/no-bare-zod-url
 *
 * Bans `z.string().url()` in favour of `httpsUrl()` from
 * `@antiphony/shared/types/url`.
 *
 * ## Why
 *
 * Zod's `.url()` is `new URL()` under the hood, which accepts EVERY scheme —
 * `javascript:`, `data:`, `file:`, `vbscript:`, `blob:`. For a URL that a client
 * dereferences (`<audio src>`, `<a href>`) that is a stored-XSS shape: the
 * payload is validated once and fires for every viewer afterwards. It bit
 * `AudioEmbedView.url` and `ActorProfileRecord.rssFeed`, and a downstream
 * consumer had to patch around the published contract rather than trust it.
 *
 * `httpsUrl()` is the same `.url()` plus a trim and an `^https?://` anchor, so
 * the fix is one call away — which is precisely why a rule is worth having.
 * Without it, the next URL field added to the contract is a coin flip.
 *
 * ## Fires on
 *
 *   z.string().url()
 *   z.string().trim().url()
 *   z.string().min(1).url().optional()
 *
 * — any `.url()` reached through a `z.string()` chain, whatever sits in between
 * or follows.
 *
 * ## Does NOT fire on
 *
 *   - `foo.url()` where the chain does not start at `z.string()` — an unrelated
 *     `.url()` method on some other object.
 *   - `z.url()` (Zod 4's top-level form). This repo is on Zod 3 and the shared
 *     package pins `^3`; add the case here if that changes, rather than
 *     guessing at it now.
 *
 * `types/url.ts` is the one file that must call `.url()` bare — it is the
 * helper. It opts out with an inline `eslint-disable-next-line`, which is the
 * point: exactly one audited exception, visible at the call site.
 *
 * ## Scope
 *
 * The chain root must be an `<ident>.string()` call. The identifier is not
 * matched against a name (`z`, `zod` and a namespace import are all legitimate
 * spellings), which keeps the rule syntactic and dependency-free. False
 * positives are essentially impossible: nothing else spells `.string().…url()`.
 */

/**
 * True when `node` is an `<ident>.string()` call — the head of a zod string
 * chain.
 */
function isZodStringCall(node) {
    return (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "string" &&
        node.callee.object.type === "Identifier"
    );
}

/**
 * Walk back down a call/member chain looking for the `z.string()` that anchors
 * it. Walking rather than checking the immediate receiver is what makes
 * `z.string().trim().url()` match as well as `z.string().url()`.
 */
function startsAtZodString(node) {
    let cursor = node;
    for (;;) {
        if (isZodStringCall(cursor)) return true;
        if (cursor.type === "CallExpression") cursor = cursor.callee;
        else if (cursor.type === "MemberExpression") cursor = cursor.object;
        else return false;
    }
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Ban bare `z.string().url()`; use `httpsUrl()` so `javascript:`/`data:`/`file:` URLs cannot enter the contract.",
        },
        messages: {
            bareUrl:
                "`z.string().url()` accepts ANY scheme (`javascript:`, `data:`, `file:`) because it is `new URL()` underneath — a stored-XSS shape for any URL a client dereferences. Use `httpsUrl()` from `@antiphony/shared/types/url` instead.",
        },
        schema: [],
    },
    create(context) {
        return {
            CallExpression(node) {
                if (
                    node.callee.type !== "MemberExpression" ||
                    node.callee.computed ||
                    node.callee.property.type !== "Identifier" ||
                    node.callee.property.name !== "url"
                ) {
                    return;
                }
                if (startsAtZodString(node.callee.object)) {
                    // Report on the `url` identifier, not the whole
                    // CallExpression: a chain written across several lines
                    // starts at `z`, and an `eslint-disable-next-line` above
                    // the `.url()` would then not match the reported line.
                    context.report({ node: node.callee.property, messageId: "bareUrl" });
                }
            },
        };
    },
};

export default rule;
