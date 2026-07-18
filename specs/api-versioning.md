# API & Docs Versioning

**Status:** Decided 2026-07-05; **implemented**. The single-source-of-truth rule
and the changelog are in place — this doc is now the standing policy, not a
proposal. Reviewed 2026-07-18 against the enrichment-pipeline work.

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

**Rule:** the API contract version is defined **once** — in
`apps/core-api/src/lib/openapi-info.ts` → `OPENAPI_INFO.version` — and every
other consumer imports it rather than re-typing the literal. When the contract
version changes, it changes there only, and `gen:openapi` propagates it to
`openapi.json` (which `openapi-surface.test.ts` and the docs build then pick up).

**Implemented.** `app.ts` imports `OPENAPI_INFO` for both the root `/`
service-info payload and the `/openapi.json` document; there is no second
literal to drift.

`package.json` versions track *package* releases and are **allowed to differ**
from the API contract version — do not conflate them, and do not "fix" the
divergence. Today `@antiphony/shared` is at `0.4.0` (the only published package)
while the contract is at `0.3.0` and the private packages sit at `0.1.0`. That
is correct: the shared package bumped for a breaking *type* export change, which
is a different event from a breaking *contract* change.

### Pre-1.0 semantics (we are here)

While `0.x`:

- **Breaking** change to the contract (removing/renaming an endpoint or field,
  tightening a type) → bump **minor** (`0.1.0` → `0.2.0`).
- **Additive** change (new endpoint, new optional field) or **fix/clarification**
  → bump **patch** (`0.1.0` → `0.1.1`).

At `1.0` we adopt strict semver (breaking → major, and a `/v2` path if the break
is non-additive).

### History

Neither break so far has introduced `/v2` — both were staged in place under
`/api/v1/`, tolerable because there are no external consumers yet.

| Contract | Change |
| :--- | :--- |
| `0.1.0` | Initial contract inherited from the `vox-pop-core-api` fork. |
| `0.2.0` | The [core-surface trim](./core-surface.md) — endpoint removals + the breaking post-view author shape. |
| `0.3.0` | The legacy-cruft sweep (`CHANGELOG.md` has the detail). |

### Next: the enrichment pipeline

[`enrichment-pipeline-plan.md`](./enrichment-pipeline-plan.md) pre-registers the
version impact of each step, so the classification is decided before the code
is written rather than argued at PR time. The summary, applying the rules above:

- Nearly every step is **additive** — new optional stage keys, one new optional
  request flag — so **patch**, and none of it forces `/v2`.
- **One minor bump.** Making the post view resolve `durationMs`/`waveform` to
  the *processed* audio variant adds and removes no field, but changes what an
  existing field **means** — a consumer reads a different number for the same
  post. Under the pre-1.0 rules that is breaking: `0.3.x` → **`0.4.0`**. It is
  the failure mode this section exists to catch, because a meaning-only change
  looks additive in a diff.
- **`@antiphony/shared` → `0.5.0`**, on the *package* axis, for renaming the
  exported `denoisedBlobCid`. Independent of the contract bump above.

## Docs

- The docs API reference is generated from `openapi.json`, so `info.version`
  surfaces automatically in the rendered reference — no separate step.
- **A contract change is not "shipped to docs" until the docs redeploy.** The
  docs site (`apps/docs`) deploys separately via Cloudflare on push; the API and
  the docs can be briefly out of step. When a contract change merges, confirm the
  docs redeploy picked up the regenerated `openapi.json`
  (`docs.antiphony.dev/openapi.json` should match the repo's).
- **Changelog.** Record every contract-version bump in
  [`CHANGELOG.md`](../CHANGELOG.md) at the repo root, one entry per version:
  what changed, and whether it is breaking. This is the human-readable companion
  to the semver number. Mark breaking items **BREAKING** inline, as the existing
  entries do.

## Checklist for a contract change

1. Change the route/schema.
2. Bump `OPENAPI_INFO.version` per the rules above.
3. `npm run gen:openapi -w @antiphony/core-api`; commit the regenerated
   `openapi.json` + `openapi.surface.json`.
4. Add a `CHANGELOG.md` entry.
5. After merge, verify the docs redeploy serves the new `openapi.json`.
