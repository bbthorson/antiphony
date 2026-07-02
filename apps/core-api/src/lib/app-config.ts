/**
 * App-level config for core-api.
 *
 * `DOMAIN` is the public domain echoed to clients when a handle is claimed
 * (`POST /users/me/handle` returns `{ handle, domain }` and stamps `domain`
 * on the user record). The default matches `UserRecordSchema`'s `domain`
 * default so a default-configured deploy and a schema-defaulted record agree.
 */
export const APP_CONFIG = {
    DOMAIN: process.env.ANTIPHONY_APP_DOMAIN || 'antiphony.dev',
} as const;
