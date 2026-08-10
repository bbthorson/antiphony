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
 * ## Audit mode — verify the edge BEFORE anything can 403
 *
 * `ANTIPHONY_ORIGIN_LOCK_AUDIT=true` alongside the secret runs the full
 * comparison and logs what it WOULD have done, then allows the request
 * regardless. It exists because there is otherwise no way to confirm the
 * Cloudflare Transform Rule is correct until enforcement is already live —
 * a misspelled header name or a value with stray whitespace looks identical
 * to a working rule until every caller is being refused.
 *
 * Note it compares, rather than merely checking the header is present. A rule
 * that sends the right header with the wrong value is exactly the failure this
 * needs to catch, and presence alone would call that healthy.
 *
 * So the real sequence is:
 *
 *   1. Deploy with the secret UNSET — no-op.
 *   2. Add the Cloudflare Transform Rule.
 *   3. Deploy with the secret set AND audit on — nothing is refused; the log
 *      says whether the edge is sending the right value.
 *   4. Drop the audit flag — enforcement begins, already verified.
 *
 * Rotation uses the same 3 → 4 pair rather than trusting the change blind.
 * Logging is capped at one line per outcome per process, so leaving audit on
 * costs two lines and does not turn request volume into log volume.
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

/**
 * Once-per-process log latches. Bounded so that neither the idle state nor
 * audit mode converts request volume into log volume.
 */
const logged = { unset: false, auditPass: false, auditFail: false };

/** `true`/`1` only — anything else, including the empty string, is off. */
function auditEnabled(): boolean {
    const raw = process.env.ANTIPHONY_ORIGIN_LOCK_AUDIT?.trim().toLowerCase();
    return raw === 'true' || raw === '1';
}

export const originLock = (): MiddlewareHandler => {
    return async (c, next) => {
        const expected = process.env.ANTIPHONY_ORIGIN_SECRET?.trim();

        if (!expected || expected.length < ORIGIN_SECRET_MIN_LENGTH) {
            if (!logged.unset) {
                logged.unset = true;
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
        const ok = Boolean(presented) && constantTimeEqual(presented as string, expected);

        // Audit mode: same verdict, no consequence. Deliberately BEFORE the
        // refusal below so turning the flag on cannot 403 anything.
        if (auditEnabled()) {
            const latch = ok ? 'auditPass' : 'auditFail';
            if (!logged[latch]) {
                logged[latch] = true;
                logger.warn(
                    {
                        path: c.req.path,
                        headerPresent: Boolean(presented),
                        wouldAllow: ok,
                    },
                    ok
                        ? '[origin-lock] AUDIT: header present and matching — safe to drop ANTIPHONY_ORIGIN_LOCK_AUDIT and enforce'
                        : '[origin-lock] AUDIT: would REFUSE this request — do NOT enforce yet; check the Cloudflare Transform Rule (header name and exact value)',
                );
            }
            return next();
        }

        if (!ok) {
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

/** Test seam — the once-per-process latches would otherwise leak across cases. */
export function __resetOriginLockWarning(): void {
    logged.unset = false;
    logged.auditPass = false;
    logged.auditFail = false;
}
