/** Default tenancy key when the deploy doesn't configure one. */
const DEFAULT_ORIGIN_APP_ID = 'antiphony';

/**
 * Resolve the origin-app tenancy key for this deploy. Read per-request (not
 * captured at module load) so tests and per-env overrides take effect.
 *
 * Every post read/write and every blob storage path is scoped by this key.
 * Today it is deploy-level config (`ANTIPHONY_ORIGIN_APP_ID`); when
 * service-to-service auth lands, authenticated app credentials override it
 * per-request (see `specs/service-auth.md`).
 */
export function getOriginAppId(): string {
    return process.env.ANTIPHONY_ORIGIN_APP_ID?.trim() || DEFAULT_ORIGIN_APP_ID;
}
