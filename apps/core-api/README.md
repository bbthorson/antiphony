# @vox-pop/core-api

> **Open-source core of [Vox Pop](https://voxpop.com).** MIT-licensed Hono service that hosts the `/api/v1/*` JSON API surface — identity, prompts, replies, organizations, inbox, and notifications. Pairs with a Firestore backend and any Firebase-compatible auth provider.
>
> **Hosted version:** [voxpop.com](https://voxpop.com). The hosted product adds IVR / call-forwarding / Twilio integration and embed-widget distribution. This repo contains only the open-core tier.

## Status

**Phase 4a complete (2026-04-24).** Every non-hosted-tier endpoint in `/api/v1/*` is live:

- 22 JSON endpoints across prompts, replies, users, organizations, handles, onboarding, uploads, inbox, and notifications.
- Firebase-wired service bindings (`UserService`, `PromptService`, `ReplyService`, `OrganizationService`, `HydrationService`, `FeedService`, `StorageService`, `RssService`).
- Bearer-token auth bridge — accepts either Firebase ID tokens or session cookie values.
- Idempotency-key support on write endpoints.
- pino structured logging + X-Request-ID correlation.

**Phase 4b (in progress):** open-source carve-out. See [`../../specs/decoupling-migration.md`](../../specs/decoupling-migration.md) § Phase 4b.

## Intentionally NOT here

These live in the closed-source `apps/web` tier and stay there:

- **IVR / call-forwarding** — Twilio integration, phone-lookup, dedicated numbers, carrier detection.
- **AT Protocol OAuth callback + client-metadata** — redirect_uri baked into PDS registrations; origin-bound.
- **CSP violation reporter** — browser sends to the `report-uri` in the page's CSP header.
- **Twilio SIP webhooks** — third-party webhook URLs are configured in Twilio's console.

## Architecture

Hono + firebase-admin, two layers:

- **`src/routes/`** — one file per endpoint. Each route validates with Zod, authenticates via the bearer middleware, and delegates to a service method.
- **`src/services/core-services-firebase.ts`** — composition root. Wires the Firebase-backed `CoreServices` binding with the `*-dependencies.ts` implementations in this package. Swappable for non-Firebase backends (Postgres, in-memory for tests) without touching `packages/core`.

No React, no Next.js, no framework magic. Just Hono handlers talking to typed services.

## Local development

```bash
npm install
npm run dev -w @vox-pop/core-api       # tsx watch; listens on :8080

# Smoke:
curl http://localhost:8080/            # → {"service":"vox-pop-core-api",...}
curl http://localhost:8080/health      # → {"ok":true}
```

With the Firebase emulators:

```bash
npx firebase emulators:start --only auth,firestore,functions,storage --project demo-vox-pop
VOXPOP_USE_EMULATOR=true npm run dev -w @vox-pop/core-api
```

## Verification

```bash
npm run typecheck -w @vox-pop/core-api
npm run build -w @vox-pop/core-api     # esbuild; bundle stays < 500kb
npm run lint -w @vox-pop/core-api
npm run test -w @vox-pop/core-api -- --run
```

## Deployment

Firebase App Hosting. [`apphosting.yaml`](./apphosting.yaml) mirrors the runtime config of the apps/web backend. Provision the backend in the Firebase console, wire secrets, and map a domain (or use the default `*.run.app` URL).

Once the backend is up, flip traffic in apps/web by setting `CORE_API_BASE_URL` in apps/web's apphosting.yaml. Rollback = unset the var.

## Why Hono, not Next.js

Next.js's runtime adds ~100MB+ of footprint for zero benefit on a JSON-only API surface (no RSC, no Image, no client hydration). Hono is ~15MB total, TypeScript-first, and App Hosting supports it natively. See [`specs/decoupling-migration.md`](../../specs/decoupling-migration.md) § Phase 4 for the full trade-off.

## License

MIT. See [LICENSE](./LICENSE).

Copyright © 2025-2026 Brad Thorson.
