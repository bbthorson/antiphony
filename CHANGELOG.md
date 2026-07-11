# Changelog

All notable changes to the Antiphony Core API contract are documented here.

Versions track the **API contract** (OpenAPI `info.version`), not package
releases — see [`specs/api-versioning.md`](./specs/api-versioning.md). The URL
major (`/api/v1/`) is unchanged; these are in-place `0.x` revisions.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] — 2026-07-11

The **legacy-cruft sweep**: finishes what the 0.2.0 core-surface trim started
by removing the Vox Pop-era leftovers the route removal left behind — in the
audio proxy, the shared contract package, and the identity-stub write path.
Breaking only for paths/exports that nothing on the current surface produces.

### Removed

- **BREAKING — legacy storage prefixes on the audio proxy.** `GET /api/v1/audio`
  now serves only the content-addressed blob namespace (`blobs/{originAppId}/{cid}`).
  The Vox Pop-era `audio/`, `prompts/`, and `replies/` prefixes — and the
  Firestore `prompts`-existence check on `replies/` paths — are gone; those
  layouts were never written by this service.
- **`@antiphony/shared` profile leftovers** (published as **0.4.0** — the trim
  scoped in `specs/core-bff-boundary.md`, "What B3 executes" item 3):
  `UserRecordSchema`/`UserRecord`, `UpdateProfileRequestSchema` (its
  `PATCH /users/me` endpoint was removed in 0.2.0), and the `httpsUrl` helper
  they used. `COLLECTIONS` no longer maps `dev.antiphony.actor.profile` to a
  Firestore collection — the lexicon is portable-schema-only, per
  `specs/core-bff-boundary.md` (core never stores actor profiles).
- **Identity-stub social fields.** `ensureUserStub` no longer writes a
  `stats: { followers, following, prompts }` block (written-but-never-read
  Vox Pop social metadata), and the atproto-signin failure cleanup no longer
  deletes a `prompts/inbox_{uid}` doc nothing creates. `UpdateProfileDto`
  shrank to the fields the signin flow actually writes (`handle`,
  `displayName`).
- **Unused `rss-parser` dependency** in `apps/core-api` (Vox Pop RSS-ingestion
  leftover).

### Docs

- API overview rewritten to the real surface: `/posts` + `/audio` only, the
  removed `/actors` / `/users` / `/atproto` / `/resolve` sections dropped, and
  auth documented as service-token-only (the stale Firebase end-user-token
  path is gone).
- `lexicons/overview.md` + `@antiphony/shared` README: `actor.profile` is
  explicitly lexicon-only (no core storage); README subpath list matches the
  modules that actually ship.
- `apps/reference` updated for the 0.2.0 author shape (`authorId` instead of
  the removed hydrated `author`).

## [0.2.0] — 2026-07-06

The **core-surface trim**: Antiphony becomes a headless store for
AT-Protocol-shaped audio posts + audio hygiene. User/profile/identity
management moves to the calling app (a BFF); the core holds no user data. This
is a breaking contract change staged in place under `/api/v1/` — tolerable
because there are no external consumers yet (see
[`specs/core-surface.md`](./specs/core-surface.md)).

### Removed

- **Leaf identity routes** — `GET /api/v1/resolve/{handle}` (handle directory is
  BFF-owned) and `POST /api/v1/atproto/disconnect` (per-user identity mgmt is
  BFF-owned).
- **Actors surface** — `POST /api/v1/actors/register` and
  `GET /api/v1/actors/{actorId}`, plus the whole actor↔DID registration vertical
  (`ActorIdentityService`, its Firestore binding, and the shared
  `ActorIdentity` types). The acting DID is asserted **per request** via
  `X-Antiphony-Acting-Actor-Did`, not registered.
- **Users surface** — the account/profile family: `GET /api/v1/users`,
  `/users/handles`, `GET|PATCH|POST /api/v1/users/me` (+ `/me/delete`,
  `/me/handle`, `/me/handle/available`), `GET /api/v1/users/{handle}`, and
  `/{handle}/profile`.
- **Public-profile projection** — `getAuthorsByIds` and the profile-read methods
  (`getUserData`, `getUserDataByUid`, `getUsersByIds`), the `CoreServices`
  aggregate, and the shared `ProfileView*` types + `PublicProfileDto`. The core
  now stores and returns zero user-profile data.

### Changed

- **BREAKING — post-view author shape.** `AudioPostView.author` (a hydrated
  `ProfileViewBasic`) is replaced by opaque references: `authorId` (the app's own
  user id) and optional `authorDid` (present only when the caller asserted one).
  The core performs no profile lookup; the BFF hydrates display identity by
  joining on `authorId`.
- **BREAKING — auth is service-token-only.** The inherited Firebase ID-token /
  session-cookie verification path was removed. Every caller is an application
  presenting `Authorization: Bearer <service-token>`; the acting end user is
  asserted via `X-Antiphony-Acting-Actor`.
- **BREAKING — reads require a service token.** `GET /api/v1/posts/{postId}` and
  `GET /api/v1/posts/{postId}/replies` now return `401` without a token: the
  credential must establish *which* tenant is being read. The ambiguous
  `ANTIPHONY_ORIGIN_APP_ID` default-tenant fallback was removed. The audio
  playback proxy (`GET /api/v1/audio`) stays anonymous by design — it is
  capability-based (allowlisted content-addressed paths → short-lived signed
  URLs).

### Docs

- OpenAPI `info` narrative rewritten to describe service-token + acting-actor
  auth (dropped the stale Firebase / `POST /api/v1/auth/session` language); the
  `Users` and `Auth` tags were dropped.
- `lexicons/overview.md`: corrected the `at://` URI-authority note to the
  app-DID authority (Model B).
- `specs/core-bff-boundary.md`: reconciled its "Actors stays in core" position,
  superseded by `core-surface.md`.

## [0.1.0]

Initial contract inherited from the `vox-pop-core-api` fork.
