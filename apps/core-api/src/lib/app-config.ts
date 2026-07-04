/**
 * App-level config for core-api.
 *
 * `DOMAIN` is the public domain echoed to clients when a handle is claimed
 * (`POST /users/me/handle` returns `{ handle, domain }` and stamps `domain`
 * on the user record). The default matches `UserRecordSchema`'s `domain`
 * default so a default-configured deploy and a schema-defaulted record agree.
 *
 * `PDS_HOST` is the host an app DID's `#atproto_pds` service endpoint must
 * point at for its pin to validate (the "custody claim is true" check in
 * `validateAllPins`). This is Antiphony's own PDS/API host — the thing a
 * tenant's `did:web` document must name for us to accept custody of its repo.
 * Unset ⇒ the host-match check is skipped (endpoint existence is still
 * required); boot logs a warning so that's an explicit, visible choice.
 */
export const APP_CONFIG = {
    DOMAIN: process.env.ANTIPHONY_APP_DOMAIN || 'antiphony.dev',
    PDS_HOST: process.env.ANTIPHONY_PDS_HOST || undefined,
} as const;
