"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitError = exports.ConflictError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthorizedError = exports.ValidationError = exports.ServiceError = void 0;
class ServiceError extends Error {
    constructor(message, status, details) {
        super(message);
        this.name = 'ServiceError';
        this.status = status;
        this.details = details;
    }
}
exports.ServiceError = ServiceError;
/** 400 — Invalid input or Zod validation failure. */
class ValidationError extends ServiceError {
    constructor(message, details) {
        super(message, 400, details);
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
/** 401 — Missing or invalid authentication credentials. */
class UnauthorizedError extends ServiceError {
    constructor(message = 'Unauthorized') {
        super(message, 401);
        this.name = 'UnauthorizedError';
    }
}
exports.UnauthorizedError = UnauthorizedError;
/** 403 — Authenticated but insufficient permissions. */
class ForbiddenError extends ServiceError {
    constructor(message = 'Forbidden') {
        super(message, 403);
        this.name = 'ForbiddenError';
    }
}
exports.ForbiddenError = ForbiddenError;
/** 404 — Resource does not exist. */
class NotFoundError extends ServiceError {
    constructor(message = 'Resource not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}
exports.NotFoundError = NotFoundError;
/** 409 — Conflict with existing state (e.g., handle already taken). */
class ConflictError extends ServiceError {
    constructor(message = 'Conflict') {
        super(message, 409);
        this.name = 'ConflictError';
    }
}
exports.ConflictError = ConflictError;
/** 429 — Client has sent too many requests. */
class RateLimitError extends ServiceError {
    constructor(message = 'Too many requests') {
        super(message, 429);
        this.name = 'RateLimitError';
    }
}
exports.RateLimitError = RateLimitError;
