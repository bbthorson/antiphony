import type { RenditionFormat } from '../lib/rendition-path.js';

/**
 * `RenditionServicePort` — derive a rendition that does not exist yet.
 *
 * ## Why this is a port and the transcode is not inline
 *
 * ffmpeg needs a subprocess and a Worker cannot spawn one. That is the single
 * requirement Cloudflare's runtime cannot satisfy at any amount of effort, so
 * the transcode lives in `apps/audio-rendition` — a container — and this is the
 * seam across which it is asked. See specs/cloudflare-migration.md § The ffmpeg
 * problem.
 *
 * Note `specs/mp3-rendition-stage.md` § Sequencing specifies
 * `adapters/outbound/ffmpeg/transcoder.ts`, an in-process adapter. That was
 * written while core-api was a Node service and is not implementable now; the
 * shape survives, the location moved across a network boundary.
 *
 * ## It returns nothing but success
 *
 * The service writes the rendition to R2 and the caller then reads it from R2,
 * exactly as it would on a cache hit. Bytes never come back through here — a
 * Worker isolate has 128MB and `readBlobBytes` already materialises a whole blob,
 * so passing the audio through in both directions would put two copies of it in
 * the tightest place in the system for no benefit.
 */

export interface RenditionRequest {
    originAppId: string;
    cid: string;
    format: RenditionFormat;
}

export interface RenditionServicePort {
    /**
     * Ensure the rendition exists, transcoding if needed.
     *
     * Resolves `true` when the rendition is now readable, `false` for every
     * other outcome — no source blob, a transcode failure, the service being
     * unreachable, or the caller's own budget elapsing before it answered.
     *
     * **Must not throw**, and must not distinguish those cases to its caller.
     * The read path's response is the same for all of them (no rendition
     * available), and a route that had to branch on why would be a route that
     * leaks the transcode backend's failure modes into a public contract. The
     * adapter logs the distinction, which is where it is useful.
     *
     * **Must be bounded.** The one consumer this exists for is a Twilio
     * `<Play>` fetch on a live call, where waiting is dead air. An adapter that
     * waited indefinitely for a cold transcode would reintroduce the exact
     * failure this whole line of work exists to delete.
     */
    ensure(request: RenditionRequest): Promise<boolean>;
}
