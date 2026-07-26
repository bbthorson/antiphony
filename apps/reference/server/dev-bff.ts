import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

/**
 * The reference app's **dev BFF** — a Vite middleware that stands in for the
 * backend-for-frontend a real integration would deploy.
 *
 * ## Why this exists
 *
 * Antiphony's only credential is a **service token** (`ANTIPHONY_APP_TOKENS`),
 * and a service token authenticates an *application*, not a person: whoever
 * holds it can act as any user in that tenancy. It therefore must never reach
 * a browser bundle. So the reference app cannot call `/api/v1/*` directly the
 * way it once did with an anonymous Firebase ID token — that path was removed
 * when core-api went service-token-only.
 *
 * The fix is the same shape every real integration has: the browser talks to
 * its **own** origin, and a server-side hop holds the credential and asserts
 * which of its users is acting. Here that hop is ~40 lines of Vite middleware
 * so the reference app stays a single `npm run dev`; in production it would be
 * your BFF, worker, or edge function. The contract it speaks to core-api is
 * identical either way:
 *
 *     Authorization: Bearer <service token>      ← from server-side env
 *     X-Antiphony-Acting-Actor: <your user id>   ← who the BFF says is acting
 *
 * ## The auth seam
 *
 * A real BFF derives the acting actor from its OWN session (a cookie, a JWT,
 * whatever it already uses). This one reads a fixed id from env, because the
 * reference app has no accounts — that substitution is the *only* difference
 * between this file and a production BFF, and it's deliberately isolated in
 * `resolveActingActor` below so it's obvious what you'd replace.
 *
 * Env is read WITHOUT a `VITE_` prefix on purpose: Vite only inlines
 * `VITE_`-prefixed vars into the client bundle, so the token stays server-side
 * by construction rather than by discipline.
 */

/**
 * Config is read lazily, per request, rather than at module load: `vite.config.ts`
 * populates `process.env` from the `.env` files via `loadEnv` while resolving the
 * config, which happens *after* this module is imported.
 */

/** Where this middleware forwards to — the core-api deployment. */
const coreApiUrl = (): string => process.env.ANTIPHONY_CORE_API_URL ?? 'http://localhost:8090';

/** The app's own service credential. Never sent to the browser. */
const serviceToken = (): string | undefined => process.env.ANTIPHONY_SERVICE_TOKEN;

/**
 * Stand-in for a real BFF's session lookup.
 *
 * A production BFF resolves this from the request's own session — it is the
 * app's internal user id, opaque to Antiphony, which stamps it on the post as
 * `authorId`. The reference app has no accounts, so it asserts one fixed
 * developer identity and every post round-trips as the same author.
 */
function resolveActingActor(_req: IncomingMessage): string {
    return process.env.ANTIPHONY_ACTING_ACTOR ?? 'reference-user';
}

/** Headers we must not forward verbatim — hop-by-hop, or ours to set. */
const STRIPPED = new Set([
    'host',
    'connection',
    'authorization', // the browser never supplies one; ours is authoritative
    'content-length', // refetched from the forwarded body
]);

function forwardedHeaders(req: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (STRIPPED.has(key) || value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('authorization', `Bearer ${serviceToken()}`);
    headers.set('x-antiphony-acting-actor', resolveActingActor(req));
    return headers;
}

async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!serviceToken()) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                success: false,
                error: {
                    message:
                        'ANTIPHONY_SERVICE_TOKEN is not set. The reference app needs a core-api ' +
                        'service token to call /api/v1/*. Set it in apps/reference/.env.local and ' +
                        'make sure the same appId:token pair is in core-api\'s ANTIPHONY_APP_TOKENS.',
                },
            }),
        );
        return;
    }

    const base = coreApiUrl();
    const target = new URL(req.url ?? '/', base);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    let upstream: Response;
    try {
        upstream = await fetch(target, {
            method: req.method,
            headers: forwardedHeaders(req),
            // Stream the body through untouched — the audio upload is
            // multipart/form-data and must not be buffered or re-encoded.
            body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
            // Required by undici whenever a stream is used as the body.
            duplex: 'half',
            redirect: 'manual', // GET /api/v1/audio 302s to a signed URL — pass it back as-is
        } as RequestInit);
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                success: false,
                error: { message: `Cannot reach core-api at ${base}: ${(err as Error).message}` },
            }),
        );
        return;
    }

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
        // Let Node recompute framing headers for the body we actually write.
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
        res.setHeader(key, value);
    });
    res.end(upstream.body ? Buffer.from(await upstream.arrayBuffer()) : undefined);
}

const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/v1/')) return next();
    void proxy(req, res);
};

/**
 * Mount the dev BFF on both the dev server and the preview server, so
 * `npm run dev` and `npm run preview` behave identically.
 */
export function devBff(): Plugin {
    return {
        name: 'antiphony-reference-dev-bff',
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}
