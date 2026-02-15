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

export class ServiceError extends Error {
    /** HTTP status code to return when this error reaches the API layer. */
    readonly status: number;
    /** Optional structured details (e.g., Zod issues). */
    readonly details?: unknown;

    constructor(message: string, status: number, details?: unknown) {
        super(message);
        this.name = 'ServiceError';
        this.status = status;
        this.details = details;
    }
}

/** 400 — Invalid input or Zod validation failure. */
export class ValidationError extends ServiceError {
    constructor(message: string, details?: unknown) {
        super(message, 400, details);
        this.name = 'ValidationError';
    }
}

/** 401 — Missing or invalid authentication credentials. */
export class UnauthorizedError extends ServiceError {
    constructor(message = 'Unauthorized') {
        super(message, 401);
        this.name = 'UnauthorizedError';
    }
}

/** 403 — Authenticated but insufficient permissions. */
export class ForbiddenError extends ServiceError {
    constructor(message = 'Forbidden') {
        super(message, 403);
        this.name = 'ForbiddenError';
    }
}

/** 404 — Resource does not exist. */
export class NotFoundError extends ServiceError {
    constructor(message = 'Resource not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

/** 409 — Conflict with existing state (e.g., handle already taken). */
export class ConflictError extends ServiceError {
    constructor(message = 'Conflict') {
        super(message, 409);
        this.name = 'ConflictError';
    }
}

/** 429 — Client has sent too many requests. */
export class RateLimitError extends ServiceError {
    constructor(message = 'Too many requests') {
        super(message, 429);
        this.name = 'RateLimitError';
    }
}
