import { RuleTester } from "eslint";
import rule from "./no-success-envelope-extras.mjs";

/**
 * Rule tests for `no-success-envelope-extras`.
 *
 * Run with: `node --test eslint-rules/no-success-envelope-extras.test.mjs`
 * (RuleTester uses Node's built-in test runner via its describe/it shim
 * since ESLint v9). No vitest dependency — keeps the rule self-contained.
 */

const ruleTester = new RuleTester();

ruleTester.run("no-success-envelope-extras", rule, {
    valid: [
        // Canonical happy path
        "c.json({ success: true, data: { id: 'x' } })",
        // Paginated — cursor nests INSIDE data, no sibling key
        "c.json({ success: true, data: { items: [], nextCursor: null } })",
        // data: null for fire-and-forget
        "c.json({ success: true, data: null })",
        // Error envelope passes — rule only fires on success: true
        "c.json({ success: false, error: { message: 'x' }, requestId: 'r' })",
        // Helper-function escape hatch — not an ObjectExpression
        "c.json(buildEnvelope(data))",
        // Non-Hono .json calls with non-envelope first arg
        "response.json()",
        // Computed key / spread bails out — false negative tolerated
        "c.json({ success: true, ...other })",
        "c.json({ success: true, [dynamicKey]: value, data: x })",
        // status arg as second param is ignored
        "c.json({ success: true, data: { id: 'x' } }, 201)",
    ],
    invalid: [
        // Sibling cursor — the exact pattern envelope-Phase-3 retired
        {
            code: "c.json({ success: true, data: [], nextCursor: null })",
            errors: [{ messageId: "extraKey", data: { key: "nextCursor" } }],
        },
        // Multiple extras flagged separately
        {
            code: "c.json({ success: true, data: x, count: 5, message: 'ok' })",
            errors: [
                { messageId: "extraKey", data: { key: "count" } },
                { messageId: "extraKey", data: { key: "message" } },
            ],
        },
        // Missing data
        {
            code: "c.json({ success: true })",
            errors: [{ messageId: "missingData" }],
        },
        // Missing data with extra — both fire. ESLint sorts reports by
        // source location, and the ObjectExpression (where `missingData`
        // is anchored) starts before its inner Property, so `missingData`
        // lands first in the output.
        {
            code: "c.json({ success: true, status: 'ok' })",
            errors: [
                { messageId: "missingData" },
                { messageId: "extraKey", data: { key: "status" } },
            ],
        },
        // String-literal key works the same as identifier
        {
            code: "c.json({ 'success': true, 'data': x, 'extra': 1 })",
            errors: [{ messageId: "extraKey", data: { key: "extra" } }],
        },
        // Numeric-literal key — stringified via `String(...)` so the
        // rule treats them the same as identifier/string keys.
        {
            code: "c.json({ success: true, data: x, 1: 'extra' })",
            errors: [{ messageId: "extraKey", data: { key: "1" } }],
        },
    ],
});

// Minimal runner shim: ESLint v9 RuleTester throws on first failure; if we
// reach here, everything passed.
console.log("no-success-envelope-extras: all RuleTester cases passed");
