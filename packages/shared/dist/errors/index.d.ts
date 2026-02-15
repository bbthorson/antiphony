/**
 * Typed service errors for consistent error handling across the API layer.
 *
 * Usage:
 *   throw new NotFoundError('Prompt not found');
 *   throw new ConflictError('Handle is already taken');
 *
 * The `withErrorHandler` middleware catches these and maps `error.status`
 * directly to the HTTP response status code.
 */
export declare class ServiceError extends Error {
    /** HTTP status code to return when this error reaches the API layer. */
    readonly status: number;
    /** Optional structured details (e.g., Zod issues). */
    readonly details?: unknown;
    constructor(message: string, status: number, details?: unknown);
}
/** 400 — Invalid input or Zod validation failure. */
export declare class ValidationError extends ServiceError {
    constructor(message: string, details?: unknown);
}
/** 401 — Missing or invalid authentication credentials. */
export declare class UnauthorizedError extends ServiceError {
    constructor(message?: string);
}
/** 403 — Authenticated but insufficient permissions. */
export declare class ForbiddenError extends ServiceError {
    constructor(message?: string);
}
/** 404 — Resource does not exist. */
export declare class NotFoundError extends ServiceError {
    constructor(message?: string);
}
/** 409 — Conflict with existing state (e.g., handle already taken). */
export declare class ConflictError extends ServiceError {
    constructor(message?: string);
}
/** 429 — Client has sent too many requests. */
export declare class RateLimitError extends ServiceError {
    constructor(message?: string);
}
