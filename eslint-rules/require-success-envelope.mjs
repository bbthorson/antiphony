/**
 * ESLint rule: antiphony/require-success-envelope
 *
 * The COMPLEMENT to `no-success-envelope-extras`. That rule guards the SHAPE of
 * a response that already opted into the envelope (`{ success: true, ... }` may
 * only carry `data`). This rule enforces that a route opts in AT ALL: any
 * inline object literal passed to `.json(...)` in a route handler MUST be an
 * envelope — i.e. contain a `success` key.
 *
 * Together they make the `{ success, data }` / `{ success: false, error }`
 * contract enforceable on apps/web's same-origin routes the way core-api's is,
 * so `api.postData()` / `unwrapEnvelope()` work uniformly. See
 * `packages/web-api/route-envelope.ts` (`jsonData` / `jsonError`).
 *
 * Fires on:
 *   - `.json({ ...no success key... })` — e.g. `{ status: 'success' }`,
 *     `{ url }`, `{ token }`, `{ customToken }`, `{ status: 'error', message }`.
 *
 * Does NOT fire on (deliberate escape hatches / unanalyzable):
 *   - `.json(someVariable)` / `.json(buildSomething())` — first arg isn't an
 *     object literal. A route that must return a non-envelope body (an external
 *     spec document like OAuth client-metadata, an oEmbed doc) assigns it to a
 *     variable first. Same convention as `no-success-envelope-extras`.
 *   - Object literals with a spread or computed key — can't be judged
 *     statically, so we bail (false-negative tolerated).
 *   - `.json()` with no argument (e.g. `await res.json()` body reads).
 *
 * Scope is set by the ESLint config `files` glob (apps/web route handlers), not
 * the rule, so the rule itself stays generic. Matches any `.json` callee (not
 * just `c.json`/`NextResponse.json`) because the receiver name varies; a stray
 * `.json()` on something else is unlikely to pass an object literal lacking
 * `success` as its first argument.
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Require route `.json(...)` responses to use the standard `{ success, data }` / `{ success: false, error }` envelope.",
        },
        messages: {
            notEnvelope:
                "Route JSON responses must use the standard envelope — `{ success: true, data }` or `{ success: false, error }` (see apps/core-api/src/lib/error-envelope.ts). Found a non-envelope object literal (no `success` key). For a deliberately raw body (external spec document), assign it to a variable first.",
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
                // Only inline object literals are analyzable. Variables /
                // calls are the escape hatch; no-arg is a body read.
                if (!arg || arg.type !== "ObjectExpression") return;

                for (const prop of arg.properties) {
                    if (prop.type !== "Property" || prop.computed) {
                        // Spread / computed key — can't judge the shape; bail.
                        return;
                    }
                    const keyName =
                        prop.key.type === "Identifier"
                            ? prop.key.name
                            : prop.key.type === "Literal"
                                ? String(prop.key.value)
                                : null;
                    if (keyName === "success") {
                        // It's an envelope (success: true|false). Shape of the
                        // success branch is the other rule's job.
                        return;
                    }
                }

                context.report({ node: arg, messageId: "notEnvelope" });
            },
        };
    },
};

export default rule;
