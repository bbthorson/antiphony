/**
 * App-level config for core-api.
 *
 * `PDS_HOST` is the host an app DID's custody service endpoint must point at
 * for its pin to validate (the "custody claim is true" check in
 * `validateAllPins`) — `#atproto_space_host`, or legacy `#atproto_pds`. This is
 * Antiphony's own API host — the thing a tenant's `did:web` document must name
 * for us to accept custody of its repo.
 *
 * The var name is now narrower than what it gates, and is kept because renaming
 * it is a coordinated config change across `wrangler.jsonc`, CI, and any
 * self-hoster's environment — for no behavioural gain. See `custodyService()`.
 * Unset ⇒ the host-match check is skipped (endpoint existence is still
 * required); boot logs a warning so that's an explicit, visible choice.
 */
export const APP_CONFIG = {
    PDS_HOST: process.env.ANTIPHONY_PDS_HOST || undefined,
} as const;

/**
 * Configuration whose absence must stop a deployment rather than degrade it.
 *
 * Deliberately short. A var belongs here only when nothing else would report
 * its absence: `SYSTEM_AUTH_TOKEN` and `ANTIPHONY_APP_TOKENS` already fail
 * closed per request with their own log lines, `ANTIPHONY_R2_BUCKET` has a
 * default, and `ANTIPHONY_PDS_HOST` and `ANTIPHONY_RENDITION_SERVICE_URL` are
 * optional by design. Adding a var that some other check already covers buys
 * nothing and makes a deployment brittle for no reason.
 */
const REQUIRED_VARS = ['ANTIPHONY_PUBLIC_BASE_URL'] as const;

/**
 * Throw unless every required var is present.
 *
 * ## Why this exists
 *
 * `ANTIPHONY_PUBLIC_BASE_URL` was unset on the deployed service from
 * 2026-08-16T21:15 until 2026-08-17. `audioPlaybackUrl` returned null, so every
 * post view hydrated with NO `embed` and no audio was reachable by any
 * consumer — for a day, unnoticed. The value was documented as required and the
 * code merely logged and degraded, which is the combination that let it survive:
 * a per-hydration error log is indistinguishable from noise, and the response
 * stayed a 200.
 *
 * So: reported once, at startup, by refusing to start.
 *
 * ## Why it reads `process.env`
 *
 * Because that is what `publicBaseUrl()` reads. A check that consults a
 * different source than the consumer can pass while the consumer still sees
 * nothing, which would be a worse failure than no check — it would prove the
 * wrong thing. On Workers this is populated from `vars` and secrets (the compat
 * date in wrangler.jsonc is what buys that), verified as available at module
 * scope, not only inside a handler.
 *
 * ## Why this is not the boot gate that was deleted
 *
 * That gate resolved every tenant's `did:web` document over the network before
 * serving, so a DNS blip became an outage and a restart was the only thing that
 * re-checked custody. This is a local read of already-loaded configuration: no
 * I/O, no dependency on anything outside the isolate, and nothing that can fail
 * intermittently. It can only fail the same way twice.
 */
export function assertRequiredConfig(env: NodeJS.ProcessEnv = process.env): void {
    const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
    if (missing.length === 0) return;

    throw new Error(
        `[app-config] missing required configuration: ${missing.join(', ')}. ` +
            'Set it under "vars" in apps/core-api/wrangler.jsonc and redeploy. ' +
            'If it IS set there and this still fires, suspect process.env population ' +
            'rather than the value — see the compatibility_date note in that file.',
    );
}

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
 * Antiphony's own DID — the only `aud` accepted on a signed service-auth token
 * (`specs/service-auth.md`, issue #116).
 *
 * ## Why an identity and not the origin URL
 *
 * An audience naming an address binds the token to wherever traffic happens to
 * point, which is the exact substitution the claim exists to prevent. So the
 * value is a DID even though nothing resolves it.
 *
 * ## Why it is derived, with an override
 *
 * Vox Pop derives their copy of this string from their `ANTIPHONY_API_BASE_URL`
 * host. Deriving ours the same way, from `ANTIPHONY_PUBLIC_BASE_URL`, means the
 * two sides cannot drift apart by editing one config — a hardcoded literal here
 * would agree with them only for as long as someone remembered it existed.
 * `ANTIPHONY_SERVICE_DID` overrides, for the day this service's DID is
 * genuinely not `did:web` of its own hostname.
 *
 * ## Caveat, deliberately not hidden
 *
 * `https://api.antiphony.dev/.well-known/did.json` is a 404 — we publish no DID
 * document. This identifier does not resolve, and both sides agree on it purely
 * by configuration. That is tolerable for a private agreement between two
 * services we operate, and it is the same species of unresolvable claim issue
 * #115 objects to when tenants have to make it. Whichever way #115 lands should
 * also settle whether this document gets published.
 */
export function serviceDid(): string | undefined {
    const explicit = process.env.ANTIPHONY_SERVICE_DID?.trim();
    if (explicit) return explicit;
    const base = publicBaseUrl();
    if (!base) return undefined;
    try {
        return `did:web:${new URL(base).host}`;
    } catch {
        return undefined;
    }
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
