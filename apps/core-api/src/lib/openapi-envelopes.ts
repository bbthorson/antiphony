import { z } from '@hono/zod-openapi';
import { errorEnvelope } from './error-envelope.js';
import type { Context } from 'hono';

/**
 * Schema helpers for OpenAPI route declarations.
 *
 * Wraps the project's success + error envelope shapes (`{ success, data }` /
 * `{ success: false, error, requestId }`) into reusable Zod schemas so each
 * `createRoute` declaration can declare its responses without re-spelling
 * the envelope contract every time.
 *
 * Reuse these across every openapi-instrumented route family.
 */

/**
 * Wraps a payload schema in the standard `{ success: true, data: T }` shape.
 *
 * Usage:
 *   responses: {
 *     200: { content: { 'application/json': { schema: successEnvelope(ProfileViewSchema) } }, description: '...' },
 *   }
 */
export function successEnvelope<T extends z.ZodTypeAny>(payload: T) {
    return z.object({
        success: z.literal(true),
        data: payload,
    });
}

/**
 * Standard error-envelope shape. Mirrors `errorEnvelope()` in
 * `./error-envelope.ts` so OpenAPI clients know what to expect on any 4xx/5xx.
 */
export const errorEnvelopeSchema = z.object({
    success: z.literal(false),
    error: z.object({
        message: z.string(),
        code: z.string().optional(),
        issues: z.unknown().optional(),
        details: z.unknown().optional(),
    }),
    requestId: z.string(),
});

/**
 * Builds a `responses` entry for a single error status code. Most endpoints
 * use this for 400/401/403/404/409/429/500 declarations.
 */
export function errorResponse(description: string) {
    return {
        content: { 'application/json': { schema: errorEnvelopeSchema } },
        description,
    };
}

/**
 * Builds a `responses[200]` entry for a successful JSON payload.
 */
export function jsonResponse<T extends z.ZodTypeAny>(payload: T, description: string) {
    return {
        content: { 'application/json': { schema: successEnvelope(payload) } },
        description,
    };
}

/**
 * Friendly message for each Zod validation target. Keyed by the
 * `target` field on the @hono/zod-openapi hook result so body / param /
 * header / cookie / form failures surface with their own labels rather
 * than the catch-all "Invalid query parameters".
 */
const VALIDATION_MESSAGES: Record<string, string> = {
    query: 'Invalid query parameters',
    param: 'Invalid path parameters',
    header: 'Invalid request headers',
    cookie: 'Invalid request cookies',
    json: 'Invalid request body',
    form: 'Invalid form data',
};

/**
 * `OpenAPIHono` `defaultHook` that emits the project's `errorEnvelope`
 * shape on request-validation failures (Zod constraints declared via
 * `createRoute({ request: ... })`). Without this, Hono's OpenAPI
 * validator emits a non-standard error shape and clients break.
 *
 * The error message reflects WHICH part of the request failed
 * validation — the result's `target` field carries that. Falls back to
 * a generic "Invalid request" if the target is missing/unknown.
 *
 * Pass to every `new OpenAPIHono({ defaultHook })` instance so the
 * surface stays uniform.
 *
 * Typed loose (matches the library's `Hook<any, E, any, any>` signature
 * for `defaultHook`) so it can be reused across route families with
 * different Variables types without per-instance casting.
 */
type ValidationResult =
    | { success: false; error: { issues: unknown }; target?: string }
    | { success: true; data: unknown; target?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const envelopeValidationHook = (result: ValidationResult, c: Context): any => {
    if (!result.success) {
        const message = (result.target && VALIDATION_MESSAGES[result.target]) || 'Invalid request';
        return c.json(
            errorEnvelope(c, message, { issues: result.error.issues }),
            400,
        );
    }
};
