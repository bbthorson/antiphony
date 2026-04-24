# @vox-pop/core-api

Hono HTTP service that hosts Vox Pop's `/api/v1/*` surface as a standalone deployment. Phase 4a of the decoupling migration — see [`specs/decoupling-migration.md`](../../specs/decoupling-migration.md) § Phase 4.

## Status

**PR #1 scaffold.** Minimum viable Hono app: `GET /` returns service identity, `GET /health` returns `{ ok: true }`. No `/api/v1/*` handlers yet, no Firebase, no auth.

Subsequent PRs:

- **PR #2** — Firebase Admin bootstrap, middleware ports (`withErrorHandler`, `rateLimit`, `X-Request-ID`), first real endpoint (`GET /api/v1/handles`), Firebase-wired `CoreServices` binding.
- **PR #3+** — remaining 65 route handlers, ported incrementally from `apps/web/src/app/api/v1/*`.
- **PR #N** — auth bridge: `apps/web`'s RSC transport sends `Authorization: Bearer <sessionCookie>`, core-api verifies via `SessionVerifier`.
- **PR #N+1** — `CORE_API_BASE_URL` env var in `apps/web`; production flip routes RSC-side fetches to this backend.

## Local development

```bash
# From the monorepo root:
npm install                            # installs core-api's deps via workspaces
npm run dev -w @vox-pop/core-api       # tsx watch; listens on :8080

# Smoke-test:
curl http://localhost:8080/            # → {"service":"vox-pop-core-api",…}
curl http://localhost:8080/health      # → {"ok":true}
```

## Build

```bash
npm run build -w @vox-pop/core-api     # tsc → dist/
npm run start -w @vox-pop/core-api     # node dist/index.js
```

## Deployment

Firebase App Hosting, second backend (alongside the existing `apps/web` backend). [`apphosting.yaml`](./apphosting.yaml) lives inside this directory and mirrors the runtime config of the web backend. The App Hosting framework adapter auto-detects Hono (see the [June 2025 announcement](https://firebase.blog/posts/2025/06/app-hosting-frameworks/)).

Backend provisioning on the Firebase side (creating the second App Hosting backend, wiring secrets, mapping a domain) is manual setup, not in-tree. Config lives here; operational wiring happens outside the repo.

## Why Hono, not Next.js

Next.js's runtime adds ~100MB+ of footprint for zero benefit on a JSON-only API surface (no RSC, no Image, no client hydration). Hono is ~15MB total, TypeScript-first, and App Hosting supports it natively. See [`specs/decoupling-migration.md`](../../specs/decoupling-migration.md) § Phase 4 for the full trade-off.

## Structure

```
apps/core-api/
  apphosting.yaml         # Firebase App Hosting config (second backend)
  package.json            # Hono + @hono/node-server; no Firebase yet
  tsconfig.json           # ESM NodeNext; strict mode
  eslint.config.mjs       # Dependency-arrow enforcement
  src/
    index.ts              # Hono app entry + serve()
```

PR #2 expands into `src/middleware/`, `src/routes/`, and `src/services/` (Firebase-wired `CoreServices` binding).
