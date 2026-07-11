/**
 * App-level config for core-api.
 *
 * `PDS_HOST` is the host an app DID's `#atproto_pds` service endpoint must
 * point at for its pin to validate (the "custody claim is true" check in
 * `validateAllPins`). This is Antiphony's own PDS/API host — the thing a
 * tenant's `did:web` document must name for us to accept custody of its repo.
 * Unset ⇒ the host-match check is skipped (endpoint existence is still
 * required); boot logs a warning so that's an explicit, visible choice.
 */
export const APP_CONFIG = {
    PDS_HOST: process.env.ANTIPHONY_PDS_HOST || undefined,
} as const;
