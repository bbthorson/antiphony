# API & Docs Versioning

**Status:** Decided 2026-07-05.

## Decision

Antiphony versions on two independent axes:

1. **URL major version — `/api/v1/`.** The path segment is the *major* version
   and the compatibility contract. It changes to `/v2` **only** for a hard,
   non-additive break that cannot be staged in place. Additive changes (new
   endpoints, new optional fields) and clarifications never move it.

2. **Contract version — OpenAPI `info.version` (semver).** Tracks the shape of
   the surface *within* a URL major. It is the number rendered in the docs API
   reference and returned by the root service-info endpoint.

### Single source of truth

The version is currently **hardcoded in three places** that can silently drift
(the workspace already shows `@antiphony/shared` at `0.3.0` while everything
else is `0.1.0`):

- `apps/core-api/src/lib/openapi-info.ts` → `OPENAPI_INFO.version`
- `apps/core-api/src/app.ts` → the root `/` service-info payload
- the various `package.json` files

**Rule:** the API contract version is defined **once** — in `openapi-info.ts` —
and `app.ts` imports it rather than re-typing the literal. `package.json`
versions track *package* releases and are allowed to differ from the *API
contract* version; do not conflate them. When the contract version changes, it
changes in `openapi-info.ts` only, and `gen:openapi` propagates it to
`openapi.json` (which `openapi-surface.test.ts` and the docs build then pick up).

### Pre-1.0 semantics (we are here)

While `0.x`:

- **Breaking** change to the contract (removing/renaming an endpoint or field,
  tightening a type) → bump **minor** (`0.1.0` → `0.2.0`).
- **Additive** change (new endpoint, new optional field) or **fix/clarification**
  → bump **patch** (`0.1.0` → `0.1.1`).

At `1.0` we adopt strict semver (breaking → major, and a `/v2` path if the break
is non-additive).

### The current change

The [core-surface trim](./core-surface.md) removes endpoints — a breaking
contract change staged **in place** under `/api/v1/`. It bumps the contract
version `0.1.0` → `0.2.0`. It does **not** introduce `/v2`: the removal is
tolerable because there are no external consumers yet.

## Docs

- The docs API reference is generated from `openapi.json`, so `info.version`
  surfaces automatically in the rendered reference — no separate step.
- **A contract change is not "shipped to docs" until the docs redeploy.** The
  docs site (`apps/docs`) deploys separately via Cloudflare on push; the API and
  the docs can be briefly out of step. When a contract change merges, confirm the
  docs redeploy picked up the regenerated `openapi.json`
  (`docs.antiphony.dev/openapi.json` should match the repo's).
- **Changelog.** Record every contract-version bump in a `CHANGELOG.md` at the
  repo root (or a `docs/changelog` page), one entry per version: what changed,
  and whether it is breaking. This is the human-readable companion to the semver
  number. (To create alongside the first bump — the `0.2.0` surface trim.)

## Checklist for a contract change

1. Change the route/schema.
2. Bump `OPENAPI_INFO.version` per the rules above.
3. `npm run gen:openapi -w @antiphony/core-api`; commit the regenerated
   `openapi.json` + `openapi.surface.json`.
4. Add a `CHANGELOG.md` entry.
5. After merge, verify the docs redeploy serves the new `openapi.json`.
