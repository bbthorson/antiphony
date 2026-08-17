import { publicBaseUrl } from './app-config.js';
import { blobObjectPath } from './blob-path.js';

/**
 * Build the playback URL for a stored blob — the value that lands in
 * `AudioEmbedView.url`.
 *
 * This used to be a short-lived signed URL pointing straight at the storage
 * bucket. It is now a URL pointing at this service's own audio proxy, because
 * the proxy streams bytes instead of redirecting (see
 * `packages/core/ports/storage-dependencies.ts`).
 *
 * Three things improve as a result, and they are the reason this is worth a
 * dedicated module rather than an inline template:
 *
 *  - **No storage round trip on the read path.** Signing was an API call per
 *    post per hydration. This is string construction.
 *  - **The URL is stable**, so a post view becomes cacheable. A signed URL
 *    expires, which made every view response effectively private and
 *    short-lived.
 *  - **No credential is involved**, which is what let the R2 binding drop the
 *    signing capability entirely.
 *
 * Returns null when the path cannot be derived (an unsafe CID or app id) or
 * when the deployment has not configured a public base URL — the caller treats
 * null as "no playable audio" and omits the embed, which is the same fallback
 * the signing failure path used.
 */
export function audioPlaybackUrl(originAppId: string, blobCid: string): string | null {
    const objectPath = blobObjectPath(originAppId, blobCid);
    if (!objectPath) return null;

    const base = publicBaseUrl();
    // Unreachable in a deployed Worker: `assertRequiredConfig()` refuses to
    // start without this. Kept as a null return rather than a throw because the
    // caller's contract is already "null means no playable audio", and because
    // this module is also imported by scripts that never boot the Worker.
    //
    // It used to log at `error` here instead — once per hydration, on the read
    // path, in a response that stayed 200. That is precisely how an unset base
    // URL went unnoticed for a day: the signal existed but was shaped like
    // noise. The check moved to startup; this branch stopped being the place
    // that reports it.
    if (!base) return null;
    return `${base}/api/v1/audio?url=${encodeURIComponent(objectPath)}`;
}
