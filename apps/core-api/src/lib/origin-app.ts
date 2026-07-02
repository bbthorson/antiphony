import type { Context } from 'hono';

/** Default tenancy key when the deploy doesn't configure one. */
const DEFAULT_ORIGIN_APP_ID = 'antiphony';

/**
 * Resolve the origin-app tenancy key for a request.
 *
 * Precedence (specs/service-auth.md):
 *   1. A service-authenticated request carries `c.var.originAppId`, derived
 *      from the app credential — the credential IS the tenancy.
 *   2. End-user (Firebase) mode falls back to deploy-level config
 *      (`ANTIPHONY_ORIGIN_APP_ID`, default `antiphony`). Read per-request
 *      (not captured at module load) so tests and env overrides take effect.
 */
export function getOriginAppId(c?: Context): string {
    const fromCredential = c?.get('originAppId');
    if (fromCredential) return fromCredential;
    return process.env.ANTIPHONY_ORIGIN_APP_ID?.trim() || DEFAULT_ORIGIN_APP_ID;
}
