/**
 * App-level config for core-api. Minimal subset of apps/web's `APP_CONFIG`
 * — just the fields the ported handlers actually read.
 *
 * All env vars intentionally share names with apps/web (`NEXT_PUBLIC_*`)
 * so a single Firebase App Hosting secret set covers both backends during
 * the rollout; we'll narrow to core-api-specific names post-flip when the
 * backends split into their own service accounts.
 */

const domain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'voxpop.com';

export const APP_CONFIG = {
    DOMAIN: domain,
    NAME: process.env.NEXT_PUBLIC_APP_NAME || 'Vox Pop',
    DEFAULT_ORG_ID: process.env.NEXT_PUBLIC_DEFAULT_ORG_ID || 'org_voxpop_default',
    DEFAULT_ORG_NAME: process.env.NEXT_PUBLIC_DEFAULT_ORG_NAME || 'Vox Pop',
    DEFAULT_ORG_SLUG: process.env.NEXT_PUBLIC_DEFAULT_ORG_SLUG || 'voxpop',
} as const;
