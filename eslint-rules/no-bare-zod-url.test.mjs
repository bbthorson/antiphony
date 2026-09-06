import { RuleTester } from "eslint";
import rule from "./no-bare-zod-url.mjs";

/**
 * Rule tests for `no-bare-zod-url`.
 *
 * Run with: `node --test eslint-rules/no-bare-zod-url.test.mjs` (RuleTester
 * uses Node's built-in test runner via its describe/it shim since ESLint v9).
 * No vitest dependency — keeps the rule self-contained.
 */

const ruleTester = new RuleTester();

ruleTester.run("no-bare-zod-url", rule, {
    valid: [
        // The replacement.
        "const s = z.object({ url: httpsUrl() });",
        "const s = z.object({ rssFeed: httpsUrl().optional() });",
        // Other zod string chains are untouched.
        "const s = z.string().min(1);",
        "const s = z.string().regex(/^at:\\/\\//);",
        // `.url()` on something that is not a zod string chain.
        "const u = request.url();",
        "const u = new URL(x).url();",
        "const u = config.endpoint.url();",
        // A chain rooted at a member expression, not an `<ident>.string()` call.
        "const u = a.b.string.url();",
    ],
    invalid: [
        {
            code: "const s = z.object({ url: z.string().url() });",
            errors: [{ messageId: "bareUrl" }],
        },
        {
            code: "const s = z.object({ rssFeed: z.string().url().optional() });",
            errors: [{ messageId: "bareUrl" }],
        },
        // Intermediate checks must not hide the `.url()`.
        {
            code: "const s = z.string().trim().url();",
            errors: [{ messageId: "bareUrl" }],
        },
        {
            code: "const s = z.string().min(1).max(2048).url().nullable();",
            errors: [{ messageId: "bareUrl" }],
        },
        // The zod import's local name is not part of the match.
        {
            code: "const s = zod.string().url();",
            errors: [{ messageId: "bareUrl" }],
        },
        // Two in one file are two reports, not one.
        {
            code: "const s = z.object({ a: z.string().url(), b: z.string().url() });",
            errors: [{ messageId: "bareUrl" }, { messageId: "bareUrl" }],
        },
    ],
});
