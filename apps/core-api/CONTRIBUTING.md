# Contributing to Antiphony

Thanks for your interest in contributing! Antiphony is open-source call-and-response
audio infrastructure: AT Protocol-shaped records (`dev.antiphony.*` lexicons), a REST
API for storing and retrieving audio posts, and audio enrichment (transcripts).

## Getting Started

### Prerequisites

- Node.js 22 (see `.nvmrc` / the pinned Volta setting)
- npm
- Java on your PATH (for the Firebase emulators)

### Setup

```bash
git clone https://github.com/bbthorson/antiphony.git
cd antiphony
npm install

# Terminal 1: Firebase emulators (auth, firestore, storage)
npx firebase emulators:start --project demo-antiphony

# Terminal 2: core-api against the emulators (port 8090)
npm run dev

# Optional, terminal 3: the reference client on http://localhost:3002
npm run dev -w @antiphony/reference
```

### Project Structure

```
apps/core-api/        — Hono REST API (this app); Firebase-backed adapters
apps/docs/            — Astro/Starlight docs site (docs.antiphony.dev)
apps/reference/       — Minimal reference client that drives the public contract
packages/core/        — Portable domain services + ports (no Firebase imports)
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
- `packages/core` must stay free of Firebase imports (lint-enforced); backend
  bindings live in `apps/core-api/src/adapters/outbound/`

## Reporting Issues

Use [GitHub Issues](https://github.com/bbthorson/antiphony/issues) for bugs and
feature requests. For security vulnerabilities, please email the maintainer
instead of opening a public issue.
