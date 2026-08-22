import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { r2Config } from './lib/blob-store.js';
import { ffmpegAvailable } from './rendition.js';

/**
 * Antiphony audio-rendition service — Hono on Node, deployed to Cloud Run.
 *
 * **This is the one Antiphony service that is deliberately not a Worker.** It
 * shells out to ffmpeg, and no Workers runtime can spawn a subprocess — see
 * `specs/archive/cloudflare-migration.md` § The ffmpeg problem for why that is a
 * decision rather than a gap, and why one small container beat both Cloudflare
 * Containers and `ffmpeg.wasm`.
 */

const app = createApp();

/** Bind to the port Cloud Run injects via `PORT`. */
const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port }, (info) => {
    logger.info(
        { port: info.port, sha: process.env.COMMIT_SHA ?? 'dev' },
        '[audio-rendition] listening',
    );
});

/**
 * Two startup probes, both AFTER binding the port, and both deliberately
 * non-fatal.
 *
 * Refusing to boot would convert a partial degradation into a total outage of
 * the `/health` endpoint the deploy workflow smoke-tests, which is how you lose
 * the ability to see what is wrong. What these buy is that the failure is
 * *legible*: one loud line at startup instead of a mystery 502 on some cache
 * miss weeks later.
 *
 * The build-time assertion in `Dockerfile` is the half that actually prevents
 * shipping a broken image; these catch a good image run somewhere unexpected.
 */
void ffmpegAvailable().then((ok) => {
    if (ok) {
        logger.info('[audio-rendition] ffmpeg present');
        return;
    }
    logger.error(
        '[audio-rendition] NO FFMPEG ON PATH — every render will 502. The image is ' +
            'missing its ffmpeg install; see the Dockerfile, which asserts it at build time.',
    );
});

const r2 = r2Config();
if (r2.missing) {
    logger.error(
        { missing: r2.missing },
        '[audio-rendition] R2 is not configured — every render will 502. This service ' +
            'cannot hold a Worker binding, so it needs S3 API credentials; see README.md § Configuration.',
    );
} else {
    logger.info({ bucket: r2.config.bucket }, '[audio-rendition] R2 configured');
}

if (!process.env.SYSTEM_AUTH_TOKEN?.trim()) {
    logger.error(
        '[audio-rendition] SYSTEM_AUTH_TOKEN unset — /render will 503 on every request. ' +
            'Fail-closed by design: an unauthenticated transcoder is an open one.',
    );
}

export { createApp };
