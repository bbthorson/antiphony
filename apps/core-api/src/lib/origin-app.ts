import type { Context } from 'hono';

/**
 * Resolve the origin-app tenancy key for a request.
 *
 * The tenancy IS the service credential: every data route is service-token
 * gated (see `middleware/auth.ts` + specs/core-surface.md, "tokenless public
 * reads"), so `c.var.originAppId` is always set on a route that calls this.
 *
 * There is no deploy-level default fallback: inferring the tenant from an env
 * var would let a tokenless request read an arbitrary tenant's data. A missing
 * credential here means a route was mounted without a token gate — a
 * programming error, surfaced loudly rather than silently reading the wrong
 * tenant.
 */
export function getOriginAppId(c: Context): string {
    const fromCredential = c.get('originAppId');
    if (!fromCredential) {
        throw new Error(
            '[origin-app] no originAppId on the request — the route must be service-token ' +
                'gated (requireAuth / requireServiceToken) before calling getOriginAppId',
        );
    }
    return fromCredential;
}
