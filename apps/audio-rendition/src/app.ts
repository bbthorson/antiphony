import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from './lib/logger.js';
import { buildRendition, InvalidRequestError, parseRequest } from './rendition.js';

/**
 * `POST /render` with `{ originAppId, cid, format }` → the rendition exists.
 *
 * ## System-authed, and that is the biggest change from what this replaced
 *
 * The Vox Pop version is **public**, because Twilio fetches `<Play>` URLs
 * anonymously and therefore cannot present a bearer. Everything defensive in
 * that service follows from that one fact: a host allowlist, a pinned bucket, a
 * CID-shape regex, and a documented reliance on the source URL's own signature
 * to bound what a caller could transcode.
 *
 * Here, Twilio is not the caller. It fetches `api.antiphony.dev/api/v1/audio?
 * format=mp3`, which is the anonymous surface; that route resolves the rendition
 * from R2 and — on a miss — calls this. So the caller is core-api, holding the
 * same `SYSTEM_AUTH_TOKEN` every other `/system/*` path takes, and this service
 * needs no anonymous-abuse story at all.
 *
 * That is worth stating plainly because it is the reason the adopted code got
 * so much smaller: the defences were not removed as an acceptable risk, the
 * thing they defended against stopped being reachable.
 *
 * ## It returns a path, not bytes
 *
 * Both ends talk to R2 directly. Passing the audio through the Worker in both
 * directions would put two copies of a multi-megabyte blob in a 128MB isolate
 * for no benefit — the Worker's job on a miss is to ask, then stream from R2
 * exactly as it would on a hit.
 */

/** Fail-closed: no configured token means the service answers nothing. */
function expectedToken(): string | null {
    const token = process.env.SYSTEM_AUTH_TOKEN?.trim();
    return token && token.length > 0 ? token : null;
}

/**
 * Constant-time bearer comparison. Same construction as core-api's
 * `constantTimeEqual`, and duplicated rather than imported because this service
 * is a separate deployable with its own dependency arrow — the two share no
 * runtime code today, and reaching across for eight lines would be the first
 * exception to that.
 *
 * Hashing first is what makes it length-independent: `timingSafeEqual` throws on
 * differing lengths, so feeding it raw secrets would both crash on a
 * wrong-length guess and leak the expected length by doing so.
 */
function tokenMatches(presented: string, expected: string): boolean {
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    return token || null;
}

export function createApp(): Hono {
    const app = new Hono();

    /**
     * Liveness + build identity. Unauthenticated, like core-api's, so a probe
     * and a deploy smoke test can reach it — and it reports the commit so "is
     * what I merged what is running" is answerable without inferring it from a
     * revision timestamp.
     */
    app.get('/health', (c) =>
        c.json({
            status: 'ok',
            service: 'audio-rendition',
            sha: process.env.COMMIT_SHA ?? 'dev',
            builtAt: process.env.BUILD_TIME ?? null,
        }),
    );

    app.post('/render', async (c) => {
        const expected = expectedToken();
        if (!expected) {
            // 503, not 500: the service is not misbehaving, it is not
            // configured. Fail-closed — never silently downgrade to serving
            // unauthenticated, which would make this an open transcoder.
            logger.error('[rendition] SYSTEM_AUTH_TOKEN unset — refusing every request');
            return c.json({ error: 'Service not configured' }, 503);
        }

        const presented = bearer(c.req.header('authorization'));
        if (!presented || !tokenMatches(presented, expected)) {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Body must be JSON' }, 400);
        }

        let request;
        try {
            request = parseRequest(body);
        } catch (err) {
            if (err instanceof InvalidRequestError) {
                logger.warn({ message: err.message }, '[rendition] rejected request');
                return c.json({ error: err.message }, 400);
            }
            throw err;
        }

        try {
            const result = await buildRendition(request);
            return c.json(result);
        } catch (err) {
            if (err instanceof InvalidRequestError) {
                // A missing SOURCE, which is the caller's input being wrong
                // rather than the transcode failing. 404 so the two are
                // distinguishable in the caller's logs; a 502 here would send
                // someone looking at ffmpeg.
                logger.warn({ ...request, message: err.message }, '[rendition] no source');
                return c.json({ error: err.message }, 404);
            }
            // Everything else is ours. The caller treats a non-2xx as "no
            // rendition available" and answers its own request accordingly, so
            // failing loudly here degrades rather than breaks.
            logger.error({ ...request, err }, '[rendition] transcode failed');
            return c.json({ error: 'Transcode failed' }, 502);
        }
    });

    return app;
}
