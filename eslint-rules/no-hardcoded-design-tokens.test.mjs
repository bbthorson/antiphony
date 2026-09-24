import { RuleTester } from "eslint";
import rule from "./no-hardcoded-design-tokens.mjs";

/**
 * Rule tests for `no-hardcoded-design-tokens`.
 *
 * Run with: `node --test eslint-rules/no-hardcoded-design-tokens.test.mjs`
 */

const ruleTester = new RuleTester({
    languageOptions: {
        parserOptions: {
            ecmaFeatures: {
                jsx: true,
            },
        },
    },
});

ruleTester.run("no-hardcoded-design-tokens", rule, {
    valid: [
        // Valid token usages
        "const s = { color: 'var(--ap-call)' };",
        "const s = { backgroundColor: 'var(--ap-surface-card)' };",
        "const s = { borderColor: 'var(--ap-border-subtle)' };",
        "const s = { color: 'inherit' };",
        "const s = { color: 'currentColor' };",
        "const s = { color: 'transparent' };",
        "const s = { color: 'none' };",
        // Starlight token overrides
        "const s = { color: 'var(--sl-color-accent)' };",
        // Unrelated properties with hex-like values
        "const s = { id: '#section-1' };",
        "const s = { atUri: 'at://did:plc:xyz/dev.antiphony.audio.post/123' };",
    ],
    invalid: [
        {
            code: "const s = { color: '#4f46e5' };",
            errors: [{ messageId: "useToken" }],
        },
        {
            code: "const s = { backgroundColor: '#f97362' };",
            errors: [{ messageId: "useToken" }],
        },
        {
            code: "const s = { borderColor: 'rgb(203, 213, 225)' };",
            errors: [{ messageId: "useToken" }],
        },
        {
            code: "const s = { fill: 'rgba(79, 70, 229, 0.2)' };",
            errors: [{ messageId: "useToken" }],
        },
        {
            code: "const s = { color: '#fff', backgroundColor: '#000' };",
            errors: [{ messageId: "useToken" }, { messageId: "useToken" }],
        },
    ],
});
