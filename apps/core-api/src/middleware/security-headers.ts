import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

/**
 * API-tier security headers for core-api.
 *
 * core-api serves **only JSON** (and proxied audio bytes) — it never renders
 * HTML, runs no inline scripts, and embeds no third-party content. That lets it
 * adopt a far stricter posture than apps/web's HTML CSP (which has to allowlist
 * Firebase/Google/reCAPTCHA for the browser app). Cloning apps/web's policy here
 * would be needlessly permissive — see `specs/architecture.md` § "Security
 * headers" and the Post-4a follow-up in `specs/decoupling-migration.md`
 * (tech-debt: "CSP hardening on apps/core-api", issue #656).
 *
 * Posture:
 *   - **CSP `default-src 'none'`** — the response document may load nothing.
 *     `frame-ancestors 'none'` blocks framing/clickjacking; `base-uri` and
 *     `form-action 'none'` are belt-and-suspenders (there is no HTML to exploit,
 *     but they cost nothing and document intent).
 *   - **`X-Frame-Options: DENY`** — legacy reinforcement of `frame-ancestors`.
 *   - **`Referrer-Policy: no-referrer`** — the API origin never needs to leak a
 *     referrer.
 *   - **`Cross-Origin-Resource-Policy: cross-origin`** — core-api is a
 *     cross-origin API *by design* (inbox./prompts./embed. → api.). The
 *     secureHeaders default of `same-origin` would break cross-origin no-cors
 *     loads (e.g. an `<audio>` element pointed at the audio proxy), so we widen
 *     it deliberately. CORS still gates credentialed `fetch()` reads.
 *   - **`Permissions-Policy`** disables powerful browser features the API never
 *     uses, so a hypothetical reflected response can't request them.
 *   - **HSTS** stays at the secureHeaders default (browsers ignore it on the
 *     plain-http localhost dev origin, so it's safe to send unconditionally).
 *
 * Mounted globally (`*`) — health/identity probes and `/openapi.json` are all
 * JSON and benefit from the same hardening.
 */
export const securityHeaders = (): MiddlewareHandler =>
    secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'none'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'none'"],
        },
        xFrameOptions: 'DENY',
        referrerPolicy: 'no-referrer',
        crossOriginResourcePolicy: 'cross-origin',
        // Disable features a JSON API has no business requesting in a browser.
        permissionsPolicy: {
            camera: [],
            microphone: [],
            geolocation: [],
            payment: [],
            usb: [],
        },
    });
