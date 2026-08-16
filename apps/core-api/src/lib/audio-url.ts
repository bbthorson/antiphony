import { publicBaseUrl } from './app-config.js';
import { blobObjectPath } from './blob-path.js';
import { logger } from './logger.js';

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
    if (!base) {
        // Fail loudly in the log but softly in the response: a misconfigured
        // deployment should degrade to "audio unavailable", not 500 every read.
        logger.error(
            '[audio-url] ANTIPHONY_PUBLIC_BASE_URL is unset — post views cannot carry a playable audio URL',
        );
        return null;
    }
    return `${base}/api/v1/audio?url=${encodeURIComponent(objectPath)}`;
}
