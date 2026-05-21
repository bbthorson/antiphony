import type { Context } from 'hono';

/**
 * Standard error envelope (Phase 4 of the envelope-standardization migration).
 *
 * Mirrors the success envelope's shape:
 *
 *   - Success: `{ success: true, data: T }`
 *   - Failure: `{ success: false, error: { message, code? }, requestId, ... }`
 *
 * `error` is a container for error-specific metadata — `message` is required,
 * `code` is an optional stable identifier (e.g. `'HANDLE_TAKEN'`) for clients
 * that branch on error type without parsing strings. Extra fields like
 * `issues` (Zod) and `details` (dev-mode internals) live under `error` too
 * so everything error-related is in one place.
 *
 * `requestId` stays at the top level for correlation — it's transport
 * metadata, not part of the error payload itself.
 *
 * Use `errorEnvelope(c, ...)` everywhere instead of hand-rolling the shape —
 * keeps the response identical across routes and middleware. Phase 5 will
 * add an ESLint rule flagging direct construction of non-standard shapes.
 */

interface ErrorEnvelopeOptions {
    /** Stable, machine-readable error identifier (e.g. `'HANDLE_TAKEN'`). */
    code?: string;
    /** Zod issue list for validation failures. */
    issues?: unknown;
    /** Dev-only internals (stack snippet, etc.). Hidden in production. */
    details?: unknown;
}

export interface ErrorEnvelopeBody {
    success: false;
    error: {
        message: string;
        code?: string;
        issues?: unknown;
        details?: unknown;
    };
    requestId: string;
}

export function errorEnvelope(
    c: Context,
    message: string,
    opts: ErrorEnvelopeOptions = {},
): ErrorEnvelopeBody {
    const error: ErrorEnvelopeBody['error'] = { message };
    if (opts.code !== undefined) error.code = opts.code;
    if (opts.issues !== undefined) error.issues = opts.issues;
    if (opts.details !== undefined) error.details = opts.details;
    return {
        success: false,
        error,
        requestId: c.get('requestId') ?? 'unknown',
    };
}
