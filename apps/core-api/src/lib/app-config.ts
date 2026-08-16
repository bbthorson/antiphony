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

/**
 * Absolute base URL this deployment is reachable at (e.g. `https://api.antiphony.dev`),
 * with no trailing slash.
 *
 * **Required for post views.** `AudioEmbedView.url` is `z.string().url()` — an
 * absolute URL — and since the audio proxy streams bytes rather than redirecting
 * to a signed one, that value is now a URL pointing back at THIS service. There
 * is no longer an external signed URL to fall back on, so a deployment without
 * this cannot hydrate a post that has audio.
 *
 * Read lazily rather than captured at module load so tests and per-env config
 * take effect without a module reset — same reasoning as `service-auth.ts`.
 */
export function publicBaseUrl(): string | undefined {
    const raw = process.env.ANTIPHONY_PUBLIC_BASE_URL?.trim();
    return raw ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * R2 bucket holding audio blobs and their derived renditions.
 *
 * One bucket, two prefixes — `blobs/{originAppId}/{cid}` for canonical audio and
 * `renditions/{originAppId}/{cid}.{format}` for derived ones. Separate buckets
 * would buy separate lifecycle rules, which is the only real argument for them,
 * and nothing needs that yet: renditions are regenerable but so cheap to keep
 * that expiring them would cost more in cold transcodes than it saves. Splitting
 * later is a prefix move, not a schema change.
 *
 * Only used to build the opaque `r2://{bucket}/{path}` handle `upload` returns;
 * the actual access goes through the Worker's R2 binding, which carries its own
 * authorisation and needs no credential here.
 */
export const R2_BUCKET_NAME = process.env.ANTIPHONY_R2_BUCKET || 'antiphony-r2-bucket';
