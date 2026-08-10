import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';
import { errorEnvelope } from '../lib/error-envelope.js';
import { constantTimeEqual } from '../lib/constant-time.js';

/**
 * Origin lock — proves a request arrived through the CDN in front of this
 * service rather than straight at the container.
 *
 * ## The gap this closes
 *
 * `api.antiphony.dev` resolves to Cloudflare, which proxies to a Cloud Run
 * managed domain mapping. But Cloud Run's default `*.run.app` hostname stays
 * publicly reachable and answers the same routes, so anything Cloudflare
 * provides — WAF, DDoS absorption, bot rules — is one hostname away from being
 * skipped. Cloudflare adds a secret header at the edge; this rejects anything
 * that arrives without it.
 *
 * Disabling the default URL would close it more completely, but the deploy
 * workflow smoke-tests each candidate revision on its own `*.run.app` tag URL
 * before promoting (deploy.yml, `--no-traffic --tag candidate`), and that gate
 * exists because boot is fail-closed on did:web resolution. Removing the URL
 * removes the gate. This keeps both.
 *
 * ## Scope
 *
 * Mounted on `/api/v1/*` only. `/`, `/health`, and `/openapi.json` stay open on
 * every hostname — deliberately, because the smoke test probes `/health` on the
 * candidate tag URL, which by definition has not been promoted and so is not
 * reachable through Cloudflare. They expose a version string, a commit sha, and
 * the public API description; none is worth the coupling.
 *
 * ## Fail-OPEN when unset — and why, given this codebase fails closed elsewhere
 *
 * `SYSTEM_AUTH_TOKEN` missing means a system route is unreachable, which is
 * safe. This secret missing would mean EVERY `/api/v1/*` request 403s — the
 * whole API, including the tenant traffic that has nothing to do with origin
 * locking. Fail-closed here converts a config gap into a total outage.
 *
 * It also makes the rollout survivable, which matters because the enforcing
 * side and the header-adding side live in different systems and cannot land
 * atomically:
 *
 *   1. Deploy this code with the secret UNSET — no-op, nothing changes.
 *   2. Add the Cloudflare Transform Rule that injects the header.
 *   3. Set the secret and redeploy — enforcement begins.
 *
 * Doing (3) before (2) takes the API down for every caller. The `warn` on the
 * first unenforced request is the reminder that the lock is installed but idle.
 *
 * Rotation follows the same order: teach Cloudflare the new value first, then
 * move the secret. During the overlap both are wrong for somebody, so rotate
 * by adding a second accepted value if that ever matters — today it does not,
 * and a brief 403 window is preferable to carrying multi-value parsing nobody
 * has needed yet.
 */

/** Header Cloudflare injects. Lowercase — Hono normalizes header lookups. */
export const ORIGIN_LOCK_HEADER = 'x-antiphony-origin';

/**
 * Minimum acceptable secret length, matching SYSTEM_AUTH_TOKEN's floor. A
 * too-short value is treated as unset (lock stays open) rather than as a
 * reason to refuse traffic — same argument as above: a weak secret is a
 * configuration problem, not grounds for an outage.
 */
const ORIGIN_SECRET_MIN_LENGTH = 32;

/** Log the "installed but idle" warning once per process, not per request. */
let warnedUnset = false;

export const originLock = (): MiddlewareHandler => {
    return async (c, next) => {
        const expected = process.env.ANTIPHONY_ORIGIN_SECRET?.trim();

        if (!expected || expected.length < ORIGIN_SECRET_MIN_LENGTH) {
            if (!warnedUnset) {
                warnedUnset = true;
                logger.warn(
                    { minLength: ORIGIN_SECRET_MIN_LENGTH, configured: Boolean(expected) },
                    expected
                        ? '[origin-lock] ANTIPHONY_ORIGIN_SECRET is shorter than the minimum; lock is OPEN and the *.run.app URL is reachable'
                        : '[origin-lock] ANTIPHONY_ORIGIN_SECRET unset; lock is OPEN and the *.run.app URL is reachable',
                );
            }
            return next();
        }

        const presented = c.req.header(ORIGIN_LOCK_HEADER);
        if (!presented || !constantTimeEqual(presented, expected)) {
            logger.warn(
                {
                    requestId: c.get('requestId'),
                    method: c.req.method,
                    path: c.req.path,
                    presented: Boolean(presented),
                },
                '[origin-lock] request did not arrive through the CDN; refusing',
            );
            // 403, not 401: there is no credential the caller could supply to
            // fix this. They reached the wrong door.
            return c.json(errorEnvelope(c, 'Forbidden'), 403);
        }

        return next();
    };
};

/** Test seam — the once-per-process warning would otherwise leak across cases. */
export function __resetOriginLockWarning(): void {
    warnedUnset = false;
}
