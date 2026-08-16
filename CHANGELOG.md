# Changelog

All notable changes to the Antiphony Core API contract are documented here.

Versions track the **API contract** (OpenAPI `info.version`), not package
releases — see [`specs/api-versioning.md`](./specs/api-versioning.md). The URL
major (`/api/v1/`) is unchanged; these are in-place `0.x` revisions.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.1] — 2026-08-16

`GET /api/v1/audio` takes an optional `format`. **Patch, not minor**: the
parameter is optional and every existing request is answered exactly as before.

### Added

- **`GET /api/v1/audio?format=mp3` serves a derived rendition** of the audio
  instead of the canonical bytes, from
  `renditions/{originAppId}/{sourceCid}.{format}`. Responses carry the format's
  own content type and the same `immutable` caching as the canonical path.

  Why: Twilio's `<Play>` cannot decode webm/opus, and does not say so — it plays
  static. `format` is the read-path answer to that, and the canonical blob is
  never re-encoded, because its CID is what every record, blob ref, and dedup
  guarantee rides on.

  The format set is **closed** (`mp3` today). An unrecognised value is a `400`
  rather than a silent fall-through to the canonical audio: serving webm/opus to
  a caller that asked for mp3 is the exact failure this parameter exists to
  remove, and it is one that presents as silence rather than as an error.

  A format with no rendition stored answers `404` with a message naming the
  format, distinct from the audio itself being absent. Transcode-on-miss lands
  with the rendition service; until then the renditions that exist are the ones
  the per-tenant processing opt-in pre-warms.

## [0.5.0] — 2026-08-16

`GET /api/v1/audio` returns the audio instead of redirecting to it. **Minor
rather than patch**: the status code and response body of a public endpoint
change, which a client asserting on either will observe.

### Changed

- **`GET /api/v1/audio` streams the bytes (200) instead of 302-ing to a
  short-lived signed URL.** It also answers `206` with `Content-Range` for a
  single `bytes=` range, advertises `Accept-Ranges`, and is cached
  `public, max-age=31536000, immutable`.

  **Clients using `<audio src="…">` need no change** — a redirect and a direct
  response are equivalent there, and seeking gets better because range support
  is now ours rather than whatever the redirect target offered. Clients that
  assert on a `302`, read the `Location` header, or follow the redirect
  manually **do** need to change.

  Why: R2 bindings cannot mint presigned URLs, so the redirect had no
  implementation on the destination platform. Streaming is the better shape
  regardless — no credential to store, no expiry to tune, no second hop, free
  egress on R2, and `immutable` caching that a URL with a one-hour TTL could
  never claim. It also fixes a documented caveat: a browser `fetch()` of this
  endpoint never worked, because following the redirect needed CORS on the
  storage bucket.

- **`url` on `dev.antiphony.embed.audio#view` is now a stable URL to this
  service's audio proxy**, not a signed storage URL. It no longer expires, so a
  cached post view stays playable — previously the whole response was
  effectively short-lived because one field inside it was.

- The endpoint now accepts a **bare object path** as well as a full provider
  URL. Its own description always claimed this; only URLs actually worked.

### Added

- **`ANTIPHONY_PUBLIC_BASE_URL` — required.** The absolute base this deployment
  is reachable at (e.g. `https://api.antiphony.dev`). Post views embed a
  playback URL pointing back at this service, so without it a post carrying
  audio hydrates with no `embed`. Unset logs an error per hydration and degrades
  to "no audio" rather than failing the request.

## [Unreleased]

### Removed

- **Six `/api/v1/system/*` endpoints**, all of them dead code with no caller:
  `POST /system/auth/mint-session-cookie`, `PUT /system/users/{uid}/bluesky-identity`,
  `POST /system/atproto/signin`, `GET|PUT|DELETE /system/atproto-state/{key}`,
  `GET|PUT|DELETE /system/atproto-session/{key}`, and
  `POST /system/rate-limit/check`.

  Each had been re-homed in the Vox Pop BFF (its Stream 4 F7 A1/A2/G1/G2), and the
  `CORE_API_BASE_URL` fallback that was the last live path back here was retired on
  that side in E2. `POST /api/v1/system/process-audio` — the queue callback — is
  unaffected and remains the only `/system/*` route.

  Removed with them: `UserService`, the `UserDependencies` port and its Firebase
  binding, `getAdminAuth()`, and the last Firebase Auth usage in the service
  (`createCustomToken`, `createUser`, `deleteUser`, `createSessionCookie`).
  **Antiphony no longer stores a user record** — the `users`, `handles`, and
  `atproto_oauth_states` collections have no writer. Authorship remains the opaque
  `authorId` / `authorDid` facets on a post, unchanged.

  **The contract version does not move.** These routes were deliberately plain-Hono
  and never appeared in the OpenAPI document, so `openapi.json` and
  `openapi.surface.json` are byte-identical across the change and no OpenAPI consumer
  observes anything. Recorded here anyway because endpoints were removed from the
  running service, which is notable to an operator even when it is invisible to the
  documented surface. See [`specs/core-bff-boundary.md`](./specs/core-bff-boundary.md)
  § Surface disposition.

## [0.4.0] — 2026-07-18

The hydrated audio embed now describes the audio it actually plays. **Minor
rather than patch**: no field is added or removed, but the VALUE of two existing
fields can now differ from what the client uploaded, which a client caching them
would observe.

### Changed

- **`embed.durationMs` and `embed.waveform` on `dev.antiphony.embed.audio#view`
  may now describe the PROCESSED variant** rather than the original upload.
  `url` has resolved to the variant since `0.3.0`; duration and peaks previously
  did not, so a trimmed post returned the processed audio beside the original
  duration and the client's original peaks — a scrubber drawn from those sits
  out of alignment with the audio under it.

  The three fields now resolve together and always agree. In practice
  `durationMs` shrinks when `trim` completes (it removes leading and trailing
  silence) and `waveform` is replaced once the `waveform` stage is `ready`.

  **Clients that persisted `durationMs` at upload time should re-read it from
  the view** and treat the trio as a set rather than caching them independently.
  Clients that already read the view per render need no change.

  The record's own `embed.durationMs` / `embed.waveform` are unchanged and
  remain immutable — this is read-time resolution, not a rewrite. Posts with no
  processing requested are byte-for-byte unaffected.

- Peaks are served only while the `waveform` stage is `ready`. During a
  recompute the stage returns to `pending` and the view falls back to the
  record's original peaks, rather than serving peaks for the superseded variant.

## [0.3.2] — 2026-07-18

Derived artifacts now follow the audio they describe. **Additive only** — the
new field is optional, and the behaviour it governs is on by default because
the alternative is serving a transcript of audio nobody can hear.

### Added

- **`reprocess`** on the processing opt-in (`POST /api/v1/posts`,
  `PATCH /api/v1/posts/{postId}`). Optional, **defaults to `true`**. When a
  byte-mutating stage (`denoise`, later `trim`) completes, every derived
  artifact that already exists — the transcript, later the waveform peaks —
  describes superseded audio, so it is marked `pending` again and recomputed
  against the new variant in the same pass. Send `reprocess: false` to keep
  the existing artifact instead and not pay to regenerate it.

### Changed

- A stage returning to `pending` after having been `ready` is now reachable in
  practice. This was already documented as normal rather than a regression;
  clients that treat any `pending` stage as "still working" need no change.
  Recompute cannot cascade — no byte-mutating stage reads a derived artifact.

## [0.3.1] — 2026-07-18

Groundwork for the [enrichment pipeline](./specs/enrichment-pipeline.md): the
processing state model widens from two stages to four. **Additive only** — no
stage runner is wired yet, so `trim` and `waveform` resolve to `skipped` on
every deployment until later steps land.

### Added

- **Two new processing stages** on the opt-in request (`POST /api/v1/posts`,
  `PATCH /api/v1/posts/{postId}`) and the per-stage status on the post view:
  **`trim`** (byte-mutating — strips leading/trailing silence) and
  **`waveform`** (derived — computes peaks over the processed audio). Both are
  optional and default off, like the existing two.
- A multi-stage request now documents its running order:
  **denoise → trim → (transcribe, waveform)**. Byte-mutating stages compose
  into a single processed variant before the derived stages read it. Request
  stages individually to override.

### Migration

> **Only affects a deployment that ran audio processing before this release.**
> If yours never wired a provider, it has no affected records and there is
> nothing to do — the script below will tell you so.

The `denoisedBlobCid` → `processedBlobCid` rename **has no automatic upgrade
path, and its failure mode is silent.** `AudioPostRecordSchema` no longer
declares the old key and Zod strips unknown keys without erroring, so on an
affected deployment nothing throws: every already-denoised post quietly
reverts to serving its **original, un-denoised audio**, and the cleaned blob is
orphaned in storage. No log line, no failed stage.

Run the one-shot migration after deploying:

```bash
# report only, writes nothing (default)
npm run migrate:processed-blob-cid -w @antiphony/core-api

# perform the migration
npm run migrate:processed-blob-cid -w @antiphony/core-api -- --apply
```

It is idempotent, batched, and needs the same credentials as the server.

### Changed

- **`@antiphony/shared` → 0.5.0** (package axis, not the contract): the stored
  `ProcessingState.denoisedBlobCid` is renamed **`processedBlobCid`** — one
  variant CID for the composed output of every byte-mutating stage, rather
  than a denoise-specific field. Breaking for type consumers reading that
  field; **not** a contract change, as it is storage-layer and never appeared
  on the view. Adds `processedDurationMs` and `waveformPeaks` alongside it, for
  variant values whose record-side counterparts (`embed.durationMs`,
  `embed.waveform`) sit inside the immutable record CID.
- Post-view playback now resolves to the processed variant whenever one exists,
  rather than specifically when `denoise === 'ready'`. Same behavior today;
  correct once a second byte-mutating stage can produce the variant.

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
