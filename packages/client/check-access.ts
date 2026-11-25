/**
 * Helper for implementing `com.atproto.managedspace.checkAccess` in a
 * managing app (Vox Pop, Bardcast; specs/cross-repo-design.md §5,
 * specs/spaces-beta-readiness.md).
 *
 * Framework-free: takes a Web-standard `Request` and returns a `Response`, so
 * it drops into Hono, Cloudflare Workers, Next.js Route Handlers, or Node.
 */

export const CHECK_ACCESS_NSID = 'com.atproto.managedspace.checkAccess';

export interface CheckAccessQuery {
    /** The space URI, `at:space/{authority}/{type}/{skey}`. */
    space: string;
    /** The requesting user's DID, when authenticated. Absent asks whether the space is publicly readable. */
    repo?: string;
    /** The OAuth client ID making the request, when present. */
    clientId?: string;
}

export interface CheckAccessDecision {
    read: boolean;
    write: boolean;
}

export interface HandleCheckAccessOptions {
    /**
     * Optional verifier for the space host's inbound service-auth `Authorization`
     * header (whose `lxm` is `com.atproto.managedspace.checkAccess`). Return
     * `{ ok: true, iss }` to proceed or `{ ok: false, message? }` to answer 401.
     */
    verifyAuth?: (
        authorizationHeader: string | null,
        query: CheckAccessQuery,
    ) => Promise<{ ok: true; iss?: string } | { ok: false; message?: string }>;
    /**
     * App-specific access decision. When `query.repo` is absent, answer for
     * public reads only (`write` should be `false`).
     */
    decide: (query: CheckAccessQuery, context: { callerDid?: string }) => Promise<CheckAccessDecision>;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * Handle `GET /xrpc/com.atproto.managedspace.checkAccess?space=&repo=&clientId=`.
 *
 * Returns `{ read, write }` (200) or an XRPC `{ error, message }` refusal
 * (400 InvalidRequest, 401 AuthenticationRequired, 405 MethodNotAllowed).
 */
export async function handleCheckAccess(
    request: Request,
    opts: HandleCheckAccessOptions,
): Promise<Response> {
    if (request.method !== 'GET') {
        return jsonResponse({ error: 'MethodNotAllowed', message: 'checkAccess is a GET query' }, 405);
    }

    const url = new URL(request.url);
    const space = url.searchParams.get('space')?.trim();
    if (!space) {
        return jsonResponse({ error: 'InvalidRequest', message: 'Missing required parameter: space' }, 400);
    }

    const repo = url.searchParams.get('repo')?.trim() || undefined;
    const clientId = url.searchParams.get('clientId')?.trim() || undefined;
    const query: CheckAccessQuery = {
        space,
        ...(repo ? { repo } : {}),
        ...(clientId ? { clientId } : {}),
    };

    let callerDid: string | undefined;
    if (opts.verifyAuth) {
        const auth = await opts.verifyAuth(request.headers.get('authorization'), query);
        if (!auth.ok) {
            return jsonResponse(
                { error: 'AuthenticationRequired', message: auth.message ?? 'Unauthorized' },
                401,
            );
        }
        callerDid = auth.iss;
    }

    const decision = await opts.decide(query, { callerDid });
    return jsonResponse({ read: Boolean(decision.read), write: Boolean(decision.write) }, 200);
}
