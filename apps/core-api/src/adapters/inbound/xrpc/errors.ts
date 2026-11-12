import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ServiceError } from 'shared/errors';
import { reportError } from 'shared/observability/report-error';
import { REPLY_CID_MISMATCH } from '@antiphony/core/services/audio-posts';
import {
    INVALID_CURSOR,
    REMOTE_BLOB_SPACE_MISMATCH,
    REMOTE_CID_MISMATCH,
    REMOTE_DELEGATION_REFUSED,
    REMOTE_POST_DELETED,
    REMOTE_POST_NOT_FOUND,
    REMOTE_RECORD_INVALID,
    REMOTE_RECORD_NOT_FOUND,
    REMOTE_REPO_UNREACHABLE,
    REMOTE_REQUEST_INVALID,
    REMOTE_URI_UNSUPPORTED,
} from '@antiphony/core/services/remote-posts';
import { logger } from '../../../lib/logger.js';

/**
 * The XRPC error dialect.
 *
 * AT Protocol specifies a flat error body — `{ error, message }` — where
 * `error` is a short symbol a client can branch on and `message` is prose for a
 * human. That is a different shape from this service's REST envelope
 * (`{ success: false, error: { message }, requestId }`), and the two must not
 * be conflated: an XRPC client parsing `error` as a string would get an object.
 *
 * Both surfaces sit over the same domain services, which raise `ServiceError`.
 * This handler is the XRPC translation of that vocabulary; `middleware/
 * error-handler.ts` is the REST one. Mounted via the sub-app's `onError`, so it
 * also catches throws from shared middleware (auth, rate-limit) on
 * XRPC routes — Hono dispatches those to the mounted app's handler, not the
 * parent's.
 */

/** The XRPC error body. `error` is the symbol; `message` is for humans. */
export interface XrpcErrorBody {
    error: string;
    message: string;
}

/**
 * HTTP status → XRPC error symbol.
 *
 * The first six are the symbols named in specs/xrpc-and-atproto-lex-strategy.md
 * §5.4. `Conflict` (409) is an addition: the spec's list omitted it, but the
 * `createPost` lexicon declares it for an idempotency conflict, and folding a
 * 409 into `InvalidRequest` would tell a client its payload was malformed when
 * the real answer is "your earlier identical request is still in flight" — the
 * one case where retrying later is correct. XRPC `createPost` raises it
 * for a duplicate `Idempotency-Key` still in flight (specs/xrpc-surface.md
 * D-5), through `xrpcError` directly rather than a thrown error.
 *
 * The last three came with the remote-post methods, whose refusals include a
 * 410 (a removed registration), a 413 (a body over the method's limit) and a
 * 503 (a repo or space authority that can't be reached right now).
 * `PayloadTooLarge` is atproto's own name for 413 (`@atproto/xrpc`'s
 * `ResponseType`). For 410 and 503 atproto has no fitting name (its 503 is
 * `NotEnoughResources`, which would send a client looking at its own request),
 * so these say what happened: the thing is gone, or the service can't answer
 * now and a retry may succeed. A remote-post client branches on the named
 * error (`RemotePostDeleted`, `RemoteRepoUnreachable`) in any case; these are
 * for whatever else raises the status, such as the tenant lookup's 503.
 *
 * A status not listed falls back by class, in `xrpcSymbol` below.
 */
const SYMBOL_BY_STATUS: Record<number, string> = {
    400: 'InvalidRequest',
    401: 'AuthenticationRequired',
    403: 'Forbidden',
    404: 'RecordNotFound',
    409: 'Conflict',
    429: 'RateLimitExceeded',
    500: 'InternalServerError',
    410: 'Gone',
    413: 'PayloadTooLarge',
    503: 'ServiceUnavailable',
};

/**
 * Domain error `code` → a named XRPC error, for the errors a lexicon declares
 * by name (a client branches on it rather than on the status alone). Anything
 * not listed falls back to the status's generic symbol.
 */
const SYMBOL_BY_CODE: Record<string, string> = {
    // dev.antiphony.audio.createPost: a reply StrongRef's CID isn't the stored record's.
    [REPLY_CID_MISMATCH]: 'ReplyCidMismatch',
    // dev.antiphony.audio.listRemotePosts: a cursor this service didn't issue.
    [INVALID_CURSOR]: 'InvalidCursor',
    // The remote-post methods (registerPost, getRemotePost, reprocessRemotePost,
    // recheckRemoteSpace), named after the REST codes they carry, so a client
    // on either surface branches on the same distinction. Each lexicon lists
    // the ones its method raises.
    [REMOTE_URI_UNSUPPORTED]: 'RemoteUriUnsupported',
    [REMOTE_REQUEST_INVALID]: 'RemoteRequestInvalid',
    [REMOTE_DELEGATION_REFUSED]: 'RemoteDelegationRefused',
    [REMOTE_RECORD_NOT_FOUND]: 'RemoteRecordNotFound',
    [REMOTE_REPO_UNREACHABLE]: 'RemoteRepoUnreachable',
    [REMOTE_CID_MISMATCH]: 'RemoteCidMismatch',
    [REMOTE_RECORD_INVALID]: 'RemoteRecordInvalid',
    [REMOTE_BLOB_SPACE_MISMATCH]: 'RemoteBlobSpaceMismatch',
    [REMOTE_POST_NOT_FOUND]: 'RemotePostNotFound',
    [REMOTE_POST_DELETED]: 'RemotePostDeleted',
};

/**
 * The XRPC symbol for a domain error: its named error if it has one, else its
 * HTTP status's. A status with no entry falls back by class: any other 4xx is
 * `InvalidRequest`, since the client has to change something before a retry
 * can succeed, and anything else is `InternalServerError`. That is the
 * classing `@atproto/xrpc` applies to an unknown status on the client side
 * (`httpResponseCodeToEnum`), so a generated client and this table agree.
 * Before this, an unlisted client error such as a 422 went out as
 * `InternalServerError`, which tells a client the fault is the server's.
 */
export function xrpcSymbol(status: number, code?: string): string {
    const named = code !== undefined ? SYMBOL_BY_CODE[code] : undefined;
    if (named) return named;
    const byStatus = SYMBOL_BY_STATUS[status];
    if (byStatus) return byStatus;
    return status >= 400 && status < 500 ? 'InvalidRequest' : 'InternalServerError';
}

/**
 * Build an XRPC error body. Exported so route handlers can answer with the
 * dialect directly (a missing required parameter, say) without throwing.
 */
export function xrpcError(error: string, message: string): XrpcErrorBody {
    return { error, message };
}

/**
 * `onError` for the XRPC sub-app. Mirrors the REST handler's mapping priority —
 * typed domain errors, then Zod, then malformed JSON, then unknown — but
 * serializes into `{ error, message }`.
 *
 * Log lines carry the same `requestId` the REST surface uses, so one request is
 * traceable across both adapters.
 */
export const xrpcErrorHandler: ErrorHandler = (error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const meta = { requestId, method: c.req.method, url: c.req.path, surface: 'xrpc' };

    // 1. Typed domain errors — including the throws from shared middleware.
    if (error instanceof ServiceError) {
        logger.warn({ ...meta, status: error.status, code: error.code, message: error.message }, 'service error');
        return c.json(
            xrpcError(xrpcSymbol(error.status, error.code), error.message),
            error.status as ContentfulStatusCode,
        );
    }

    // 2. Zod throws from `.parse()`. Handlers here use `.safeParse` and shape
    //    their own 400s, so this is the backstop rather than the common path.
    if (error instanceof z.ZodError) {
        logger.warn({ ...meta, issues: error.issues }, 'validation error');
        return c.json(xrpcError('InvalidRequest', 'Payload failed schema validation'), 400);
    }

    // 3. Malformed request body — the client's fault, so 400 not 500.
    if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === 'Malformed JSON in request body')
    ) {
        logger.warn({ ...meta, message: error.message }, 'invalid json body');
        return c.json(xrpcError('InvalidRequest', 'Invalid JSON body'), 400);
    }

    // 4. Unknown — never leak internals. Reported to Error Reporting for the
    //    same reason the REST handler reports only this branch: the ones above
    //    are expected client errors, not crashes.
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...meta, error: err.message, stack: err.stack }, 'unhandled xrpc error');
    reportError(err, meta);
    return c.json(xrpcError('InternalServerError', 'An unexpected error occurred'), 500);
};
