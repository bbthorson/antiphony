import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from './lib/logger.js';
import { buildRendition, InvalidRequestError, parseRequest } from './rendition.js';
import { trim, waveform } from './stages.js';

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
 * ## `/render` returns a path, not bytes
 *
 * Both ends talk to R2 directly. Passing the audio through the Worker in both
 * directions would put two copies of a multi-megabyte blob in a 128MB isolate
 * for no benefit — the Worker's job on a miss is to ask, then stream from R2
 * exactly as it would on a hit.
 *
 * ## Why `/trim` and `/waveform` take bytes, when `/render` does not
 *
 * The asymmetry is deliberate and it is imposed by the ports, not chosen here.
 *
 * `TrimmerPort` and `WaveformPort` in `@antiphony/core` are `bytes in, result
 * out`, and `AudioProcessingService` orchestrates the storage around them — it
 * calls `readBlobBytes`, hands the bytes to the port, and passes the result to
 * `writeDerivedBlob`, which content-addresses it. That ordering is what makes
 * the derived CID Antiphony's to compute, and the derived CID goes INTO a record
 * as a `BlobRef`, so it has to be.
 *
 * Giving these endpoints `{originAppId, cid}` instead would mean this service
 * writing a canonical blob and computing its CID — moving `dag-cbor` and the
 * content-addressing rules into a transcoder, and making a second thing
 * responsible for the invariant the whole blob scheme rests on. The ports stay
 * as they are; the adapters became a `fetch`. specs/cloudflare-migration.md
 * § The ffmpeg problem says exactly this: "`TrimmerPort` and `WaveformPort` are
 * unchanged — the adapters become a `fetch` at the rendition service instead of
 * an `execFile`."
 *
 * The cost is that a blob transits the Worker to get here. The upload route caps
 * at 25MB against a 128MB isolate, so it survives — and the same spec names
 * streaming the port as the right long-term shape and not a blocker today.
 * `/waveform` is already the cheap half: only the request carries audio, and the
 * response is a few hundred numbers.
 *
 * Raw body plus `Content-Type` rather than multipart or base64: the mime type IS
 * a content type, and base64 would inflate a 25MB upload by a third for nothing.
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

/**
 * The system-auth gate every working route shares. Returns a response to send
 * when the caller is refused, or `null` to proceed.
 *
 * One function rather than three copies, because there are three routes now and
 * every one of them spends CPU on ffmpeg. A route that forgot this would be an
 * open transcoder with a write path into Antiphony's bucket — the failure mode
 * worth making structurally hard rather than remembered.
 */
function authorise(c: Context): Response | null {
    const expected = expectedToken();
    if (!expected) {
        // 503, not 500: the service is not misbehaving, it is not configured.
        // Fail-closed — never silently downgrade to serving unauthenticated.
        logger.error('[audio-rendition] SYSTEM_AUTH_TOKEN unset — refusing every request');
        return c.json({ error: 'Service not configured' }, 503);
    }
    const presented = bearer(c.req.header('authorization'));
    if (!presented || !tokenMatches(presented, expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
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
        const denied = authorise(c);
        if (denied) return denied;

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

    /**
     * `POST /trim` — audio in the body, trimmed audio back.
     *
     * `Content-Type` carries the input mime type, which the stage needs: the
     * pass-through shortcut for already-trimmed audio compares against it, and
     * getting that wrong costs an Opus→Opus generation on every re-request.
     *
     * The response carries the output mime type in `Content-Type` and the
     * measured duration in `X-Duration-Ms`. That duration becomes
     * `processedDurationMs`, which the read view serves as the post's duration,
     * so it is part of the result rather than a diagnostic.
     */
    app.post('/trim', async (c) => {
        const denied = authorise(c);
        if (denied) return denied;

        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length === 0) return c.json({ error: 'Empty body' }, 400);

        try {
            const result = await trim(bytes, c.req.header('content-type') ?? 'application/octet-stream');
            return c.body(new Uint8Array(result.bytes), 200, {
                'content-type': result.mimeType,
                'content-length': String(result.bytes.length),
                'x-duration-ms': String(result.durationMs),
            });
        } catch (err) {
            logger.error({ err, bytes: bytes.length }, '[stages] trim failed');
            return c.json({ error: 'Trim failed' }, 502);
        }
    });

    /**
     * `POST /waveform` — audio in the body, peaks back.
     *
     * The cheap direction: the response is a few hundred numbers, so only the
     * request carries audio.
     */
    app.post('/waveform', async (c) => {
        const denied = authorise(c);
        if (denied) return denied;

        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length === 0) return c.json({ error: 'Empty body' }, 400);

        try {
            return c.json(await waveform(bytes));
        } catch (err) {
            logger.error({ err, bytes: bytes.length }, '[stages] waveform failed');
            return c.json({ error: 'Waveform failed' }, 502);
        }
    });

    return app;
}
