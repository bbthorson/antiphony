import { RuleTester } from "eslint";
import rule from "./require-success-envelope.mjs";

/**
 * Rule tests for `require-success-envelope`.
 *
 * Run with: `node --test eslint-rules/require-success-envelope.test.mjs`
 * (RuleTester uses Node's built-in test runner via its describe/it shim
 * since ESLint v9). No vitest dependency — keeps the rule self-contained.
 */

const ruleTester = new RuleTester();

ruleTester.run("require-success-envelope", rule, {
    valid: [
        // Success envelope
        "NextResponse.json({ success: true, data: { url: 'x' } })",
        "NextResponse.json({ success: true, data: null }, { status: 200 })",
        // Error envelope — has a `success` key (false)
        "NextResponse.json({ success: false, error: { message: 'x' } }, { status: 400 })",
        // Variable / call argument is the escape hatch — not an object literal
        "NextResponse.json(metadata, { headers })",
        "NextResponse.json(jsonData(x))",
        // No-arg body read
        "res.json()",
        // Spread / computed key bails (false-negative tolerated)
        "NextResponse.json({ ...envelope })",
        "NextResponse.json({ [k]: v })",
        // `success` as a string literal key still counts
        "NextResponse.json({ 'success': true, data: 1 })",
    ],
    invalid: [
        // The ad-hoc shapes this migration retires
        {
            code: "NextResponse.json({ status: 'success' })",
            errors: [{ messageId: "notEnvelope" }],
        },
        {
            code: "NextResponse.json({ url: url.toString() })",
            errors: [{ messageId: "notEnvelope" }],
        },
        {
            code: "NextResponse.json({ token: customToken })",
            errors: [{ messageId: "notEnvelope" }],
        },
        {
            code: "NextResponse.json({ customToken: token })",
            errors: [{ messageId: "notEnvelope" }],
        },
        {
            code: "NextResponse.json({ status: 'error', message: 'Invalid' }, { status: 400 })",
            errors: [{ messageId: "notEnvelope" }],
        },
        {
            code: "NextResponse.json({ status: 'success', atUri })",
            errors: [{ messageId: "notEnvelope" }],
        },
    ],
});
