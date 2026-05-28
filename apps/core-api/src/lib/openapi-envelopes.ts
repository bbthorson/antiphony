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
 * `OpenAPIHono` `defaultHook` that emits the project's `errorEnvelope`
 * shape on request-validation failures (Zod constraints declared via
 * `createRoute({ request: ... })`). Without this, Hono's OpenAPI
 * validator emits a non-standard error shape and clients break.
 *
 * Pass to every `new OpenAPIHono({ defaultHook })` instance so the
 * surface stays uniform.
 *
 * Typed loose (matches the library's `Hook<any, E, any, any>` signature
 * for `defaultHook`) so it can be reused across route families with
 * different Variables types without per-instance casting.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const envelopeValidationHook = (result: { success: false; error: { issues: unknown } } | { success: true; data: unknown }, c: Context): any => {
    if (!result.success) {
        return c.json(
            errorEnvelope(c, 'Invalid query parameters', { issues: result.error.issues }),
            400,
        );
    }
};
