/**
 * ESLint rule: vox-pop/no-success-envelope-extras
 *
 * Enforces the standard success envelope contract on Hono responses:
 *
 *   c.json({ success: true, data: <T> }, [status])
 *
 * Fires on:
 *   1. Extra keys beyond `success` and `data` inside a `{success: true, ...}`
 *      object literal passed to `.json(...)`. Paginated responses nest the
 *      cursor INSIDE `data` (post envelope-Phase-3), so `nextCursor` as a
 *      sibling of `success` is exactly the regression this rule blocks.
 *   2. Missing `data` field — `c.json({success: true})` is also a violation
 *      (Phase 2 of envelope-standardization made `data` required). Use
 *      `data: null` for fire-and-forget responses.
 *
 * Does NOT fire on:
 *   - Computed properties or spread elements — those resolve at runtime
 *     and aren't safe to analyze statically. False-negative tolerated;
 *     the helper-function escape hatch is the workaround.
 *   - `.json(buildEnvelope(...))` — only direct ObjectExpressions are
 *     checked. Wrap construction in a helper to bypass intentionally.
 *   - `success: false` envelopes — those are the error path, enforced by
 *     convention through `errorEnvelope(c, ...)` from
 *     `apps/core-api/src/lib/error-envelope.ts` (and the telephony mirror).
 *
 * Scope: the rule matches any `.json(...)` callee, not just `c.json(...)`,
 * because we don't know the Hono context variable name in all routes
 * (`c`, `ctx`, etc.). False positives on unrelated `.json()` callers
 * (e.g. `response.json()` data extractor calls) are unlikely because those
 * don't pass an object literal first argument with a `success: true` field.
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Enforce the standard `{ success: true, data: T }` envelope on Hono `c.json(...)` calls.",
        },
        messages: {
            extraKey:
                "Success envelope `{ success: true, ... }` must only contain `data` alongside `success`. Found extra key: `{{key}}`. Paginated responses nest the cursor INSIDE `data` — e.g. `{ success: true, data: { items, nextCursor } }`.",
            missingData:
                "Success envelope `{ success: true }` is missing the required `data` field. Use `data: null` for fire-and-forget responses.",
        },
        schema: [],
    },
    create(context) {
        return {
            CallExpression(node) {
                if (
                    node.callee.type !== "MemberExpression" ||
                    node.callee.property.type !== "Identifier" ||
                    node.callee.property.name !== "json"
                ) {
                    return;
                }

                const arg = node.arguments[0];
                if (!arg || arg.type !== "ObjectExpression") return;

                let hasSuccessTrue = false;
                let hasData = false;
                const extras = [];

                for (const prop of arg.properties) {
                    if (prop.type !== "Property" || prop.computed) {
                        // Spread elements / computed keys are out of scope —
                        // see file header. Once we see one, we can't safely
                        // judge the shape, so bail out entirely.
                        return;
                    }

                    const keyName =
                        prop.key.type === "Identifier"
                            ? prop.key.name
                            : prop.key.type === "Literal"
                                // String() catches numeric keys like
                                // `{ 1: ... }` too — without it the rule
                                // would silently ignore them. Bigint /
                                // null / regex literal keys aren't legal
                                // in object-literal property positions,
                                // so String() is total here.
                                ? String(prop.key.value)
                                : null;
                    if (keyName === null) continue;

                    if (keyName === "success") {
                        if (
                            prop.value.type === "Literal" &&
                            prop.value.value === true
                        ) {
                            hasSuccessTrue = true;
                        } else {
                            // `success: false` / `success: someVar` — not our case.
                            return;
                        }
                    } else if (keyName === "data") {
                        hasData = true;
                    } else {
                        extras.push({ node: prop, key: keyName });
                    }
                }

                if (!hasSuccessTrue) return;

                for (const extra of extras) {
                    context.report({
                        node: extra.node,
                        messageId: "extraKey",
                        data: { key: extra.key },
                    });
                }

                if (!hasData) {
                    context.report({
                        node: arg,
                        messageId: "missingData",
                    });
                }
            },
        };
    },
};

export default rule;
