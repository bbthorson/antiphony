# Contributing to Antiphony

Thanks for your interest in contributing! Antiphony is open-source call-and-response
audio infrastructure: AT Protocol-shaped records (`dev.antiphony.*` lexicons), a REST
API for storing and retrieving audio posts, and audio enrichment (transcripts).

## Getting Started

### Prerequisites

- Node.js 22 (see `.nvmrc` / the pinned Volta setting)
- npm
- A Postgres database reachable over Neon's HTTP SQL endpoint (a free Neon
  branch is the easy path). The SQL client POSTs to `https://<host>/sql` rather
  than opening a TCP connection, so a plain local Postgres will not answer it.

### Setup

```bash
git clone https://github.com/bbthorson/antiphony.git
cd antiphony
npm install

# Apply the schema once, to an empty database.
psql "$DATABASE_URL" -f apps/core-api/db/schema.sql
```

core-api runs on the Workers runtime, so its config is not shell environment —
it goes in `apps/core-api/.dev.vars` (gitignored):

```bash
DATABASE_URL="postgresql://…@ep-….neon.tech/neondb?sslmode=require"
ANTIPHONY_APP_TOKENS="local:a-local-dev-token-at-least-32-chars-long"
ANTIPHONY_APP_DIDS="local:did:web:your-domain.example"
ANTIPHONY_PUBLIC_BASE_URL="http://localhost:8787"
```

Then:

```bash
# Terminal 1: core-api via `wrangler dev` on :8787. R2, KV, the queue and the
# rate-limit Durable Object are all simulated locally; only the database is real.
npm run dev

# Optional, terminal 2: the reference client on http://localhost:3002
npm run dev -w @antiphony/reference
```

`ANTIPHONY_APP_DIDS` needs a domain you control serving a `did:web` document —
custody is proven per request and `did:web` resolution is HTTPS-only, so there
is no localhost shortcut. See the
[quick start](https://docs.antiphony.dev/self-hosting/quick-start/).

### Project Structure

```
apps/core-api/        — Hono REST API (this app), on Cloudflare Workers
apps/audio-rendition/ — ffmpeg container on Cloud Run; the trim/waveform/mp3 backend
apps/docs/            — Astro/Starlight docs site (docs.antiphony.dev)
apps/reference/       — Minimal reference client that drives the public contract
packages/core/        — Portable domain services + ports (no vendor SDK imports)
packages/shared/      — Published contract: Zod schemas, codecs, NSIDs
lexicons/dev/antiphony/ — AT Protocol lexicon definitions (source of truth)
```

## Development Workflow

1. Fork the repo and create a branch from `master`
2. Make your changes
3. `npm run typecheck && npm run lint && npm test`
4. If you changed a route contract, regenerate the OpenAPI spec:
   `npm run gen:openapi` (the file is committed)
5. Open a pull request

## Code Style

- TypeScript strict mode everywhere
- Zod schemas for all request/response validation; record shapes mirror the
  lexicons in `lexicons/dev/antiphony/`
- Every JSON response uses the envelope: `{ success: true, data }` /
  `{ success: false, error, requestId }` (lint-enforced via `eslint-rules/`)
- Use the `ServiceError` hierarchy from `@antiphony/shared` (`NotFoundError`,
  `ForbiddenError`, …) — the error-handler middleware maps them to HTTP statuses
- `packages/core` must stay free of vendor SDK imports (lint-enforced); backend
  bindings live in `apps/core-api/src/adapters/outbound/`
- Anything reachable from `app.ts` has to run on Workers. `npm run
  check:worker-bundle -w @antiphony/core-api` bundles the entry and fails on a
  Node-only dependency; nothing else catches that, and `wrangler deploy` will
  happily ship a Worker that dies on its first request

## Reporting Issues

Use [GitHub Issues](https://github.com/bbthorson/antiphony/issues) for bugs and
feature requests. For security vulnerabilities, please email the maintainer
instead of opening a public issue.
