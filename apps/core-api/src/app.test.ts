import { describe, it, expect, vi } from 'vitest';

/**
 * The composition root, stubbed — which is what these suites want and what they
 * were reaching for all along.
 *
 * This file used to mock `lib/firebase-admin.js` instead, and the reason is
 * worth keeping because it describes a trap that outlived Firestore. The
 * CORS/CORP assertions below request `/api/v1/audio`, and that route carries
 * `rateLimit(RATE_LIMITS.read)` — middleware that runs BEFORE the handler and
 * asks the rate-limit store. Unmocked, the request therefore waited on a live
 * store, and in CI it never got one: firebase-admin sat in Application Default
 * Credentials resolution until vitest gave up at 5s. That is what "Test timed
 * out in 5000ms" on `answers a cross-origin request without any CORS headers`
 * was — a credential lookup, not anything about CORS.
 *
 * It was worse on a developer machine, where it did NOT fail: gcloud ADC is
 * usually present, so the test quietly authenticated and transacted against a
 * real `rate_limits` collection. Passing locally and hanging in CI is the same
 * bug wearing two faces.
 *
 * The store is Postgres now, so the failure mode would be an HTTPS call to a
 * hostname that does not resolve rather than a credential hunt — different
 * dependency, same hang. Mocking the composition root cuts it off at the seam
 * both bindings come through, which is also how `adapters/inbound/rest/
 * audio.test.ts` does it. These suites assert the HTTP surface — headers, the
 * OpenAPI document, the shape of `/health` — and none of that needs a store.
 */
vi.mock('./composition.js', () => ({
    servicesFor: () => ({
        backend: 'postgres' as const,
        // `/health` hands this to `dataPresence`. Answering `empty` keeps the
        // probe in-process; the assertions below are about the envelope, and
        // lib/data-presence.test.ts owns what the readings mean.
        sql: { query: async () => [{ present: false }] },
        storage: { extractObjectPath: () => null },
        // Under limit on every hit: this is route surface, not rate-limit
        // policy (that is middleware/rate-limit.test.ts).
        rateLimitStore: { hit: async () => 'under' as const },
    }),
}));

process.env.LOG_LEVEL = 'silent';

// Dynamic, so the mock above is registered before app.ts pulls the composition
// root in at module scope.
const { app } = await import('./app.js');

// The `parseAllowedOrigins` suite that stood here went with the CORS
// middleware — see the note at the top of app.ts. Its replacement is the
// no-CORS assertion in the security-headers suite below: what actually has to
// hold now is that a cross-origin `<audio>` load still works, and that is a
// Cross-Origin-Resource-Policy guarantee rather than a CORS one.

describe('CORS', () => {
    it('answers a cross-origin request without any CORS headers', async () => {
        const a = app();
        const res = await a.fetch(
            new Request('http://localhost/api/v1/audio?url=nope', {
                headers: { origin: 'https://embed.example.com' },
            }),
        );
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('still permits cross-origin no-cors media loads via CORP', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/api/v1/audio?url=nope'));
        // This — not CORS — is what lets `<audio src="…/api/v1/audio?url=…">`
        // load from a page on another origin.
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    });
});

describe('OpenAPI document', () => {
    it('serves a well-formed spec at /openapi.json with the canonical surface present', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/openapi.json'));
        expect(res.status).toBe(200);
        const doc = await res.json();
        expect(doc.openapi).toBe('3.0.0');
        expect(doc.info?.title).toBe('Antiphony Core API');

        const paths = Object.keys(doc.paths ?? {});
        // The canonical Antiphony surface: audio posts (/posts) and audio
        // storage (/audio). When new routes join the documented contract,
        // spot-check them here.
        expect(paths).toContain('/api/v1/posts');
        expect(paths).toContain('/api/v1/posts/{postId}');
        expect(paths).toContain('/api/v1/posts/{postId}/replies');
        expect(paths).toContain('/api/v1/audio/upload');
        // Legacy prompt/reply/org surface is gone. ("Replies addressed to author
        // X" is a facet on /posts — `?rootAuthor=` — not a resurrected /replies.)
        expect(paths).not.toContain('/api/v1/prompts');
        expect(paths).not.toContain('/api/v1/replies');
        expect(paths).not.toContain('/api/v1/organizations');
        // Account/profile management moved to the BFF — the Users family is gone.
        expect(paths).not.toContain('/api/v1/users');
        expect(paths).not.toContain('/api/v1/users/me');
        expect(paths).not.toContain('/api/v1/users/{handle}');
        expect(paths.length).toBeGreaterThanOrEqual(5);
    });

    it('describes authentication in info.description', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/openapi.json'));
        const doc = await res.json();
        expect(doc.info?.description).toMatch(/Authentication/);
        expect(doc.info?.description).toMatch(/Authorization: Bearer/);
        expect(doc.info?.description).toMatch(/Envelope/);
    });
});

describe('Security headers', () => {
    it('sends a strict API-tier CSP on JSON responses', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        const csp = res.headers.get('content-security-policy');
        expect(csp).toBeTruthy();
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("form-action 'none'");
    });

    it('denies framing and sets the hardening headers', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        // Cross-origin by design: same-origin would break cross-origin no-cors
        // loads (e.g. <audio> against the audio proxy). CORS still gates fetch.
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        expect(res.headers.get('permissions-policy')).toContain('microphone=()');
    });

    it('applies the headers to /api/v1/* routes too', async () => {
        // The middleware is global (`*`), so even an unmatched /api/v1/* path
        // (404) carries the headers — which is exactly what we want to assert:
        // the policy reaches the API surface, not just the root probes.
        const a = app();
        const res = await a.fetch(new Request('http://localhost/api/v1/nonexistent'));
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    });
});

describe('GET /health', () => {
    it('returns ok:true with sha and deployedAt fields', async () => {
        const a = app();
        const res = await a.fetch(new Request('http://localhost/health'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(typeof body.sha).toBe('string');
        // deployedAt is null in dev (esbuild define not applied by tsx)
        expect('deployedAt' in body).toBe(true);
    });
});
