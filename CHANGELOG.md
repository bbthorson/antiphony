# Changelog

All notable changes to the Antiphony Core API contract are documented here.

Versions track the **API contract** (OpenAPI `info.version`), not package
releases — see [`specs/api-versioning.md`](./specs/api-versioning.md). The URL
major (`/api/v1/`) is unchanged; these are in-place `0.x` revisions.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.10.0] — 2026-10-27

Deleting posts and their audio ([`specs/deletion.md`](./specs/deletion.md)).
Until now nothing could be removed. **Minor**: the routes are additive, but
two existing things can now mean something new.

### Added

- **`DELETE /api/v1/posts/{postId}`** hard-deletes a post: its record, its
  transcript, and every blob and rendition no remaining post in the tenant
  references. `?replies=delete|keep|keep-with-did` (default `delete`) decides
  what happens to the replies below it; `keep-with-did` keeps each reply that
  has an `authorDid`. A kept reply keeps its URI, CID and space. A large subtree
  is removed over several calls, deepest first and the post last, reported by
  `complete`. A repeated delete answers `status: already-deleted`.
- **`POST /api/v1/authors/{authorId}/erase`** deletes every post an author wrote,
  paged by `limit` (default 100, at most 200), for account erasure. The author's
  own posts are always deleted; `replies` governs other people's replies below
  them.
- **`DELETE /api/v1/spaces/{spaceType}/{skey}`** deletes an empty space
  (`409`, `SPACE_NOT_EMPTY`, while posts remain).
- A **`post.deleted`** webhook per deleted post, on the tenant's existing
  webhook URL and signature.

### Changed

- **BREAKING:** `GET /api/v1/posts/{postId}` answers **`410`** with
  `code: POST_DELETED` for a post the tenant deleted. A never-existent id is
  still `404`.
- **BREAKING (meaning):** a reply's `reply.parent` and `reply.root` StrongRefs
  can now name a post that no longer exists, when the post was deleted with
  `replies=keep` or `keep-with-did`. Until now they always resolved. No field
  changed.
- Stage-settled webhooks gain `"type": "stage.settled"`, so a receiver can tell
  them from `post.deleted`. Additive.
- Deletes need only the service token; no `X-Antiphony-Acting-Actor` is
  required. Who may delete is the calling app's decision.

### Internal

- Migration `0003_deletion.sql`: the `deleted_posts` ledger (URI and time only),
  the `blob_deletions` queue, and indexed references for the shared-blob check.
  The hourly cron finishes any blob deletion a call left queued.
- Processing records every variant it writes (`processing.derivedBlobCids`), so
  a delete finds a denoised blob that a trim in the same pass replaced. Variants
  written before this release aren't recorded.

`@antiphony/shared` gains `RepliesPolicySchema`, the deletion result schemas,
`EraseAuthorRequestSchema` and the optional `derivedBlobCids` on
`ProcessingStateSchema`. That needs a package release (`0.10.0` on the package
axis) before a consumer can import them; this entry doesn't publish one.

## [0.9.2] — 2026-10-17

Documentation of the contract only; no request, response or runtime validation
changes. **Patch.**

### Fixed

- **URL fields declare `format: uri` again.** `embed.audio#view.url` and a
  space's `managingAppEndpoint` carry `format: "uri"` alongside their
  `http`/`https` scheme `pattern` in `openapi.json`, matching the lexicons
  (`actor.profile.rssFeed` gets the same fix in `@antiphony/shared`, but no
  REST route returns it). The format was dropped by the zod 4 migration (the scheme
  `.regex()` claimed the schema's single format slot after `.url()`); the
  runtime has validated these fields as URLs throughout, so a value that was
  valid before is valid now. A client generated from the document may now type
  them as URIs.
- **`GET /api/v1/posts/{postId}` no longer says "signed audio URL".** The post
  view's playback URL points at the audio proxy (`GET /api/v1/audio`), which
  streams the bytes, and is signed and expiring only for audio in a space. The
  `Audio` tag and `POST /api/v1/posts` descriptions said the same stale thing
  ("signed-URL playback proxy", "signed-URL flow") and are corrected too.

## [0.9.1] — 2026-10-11

A clarification and a fix; no request or response shape changes. **Patch.**

### Fixed

- **XRPC `dev.antiphony.audio.createPost` declares `Forbidden`.** A reply by
  an actor who isn't a participant in the branch has always been refused with
  `403` / `Forbidden`, but the lexicon's `errors` didn't list it, so a client
  generated from the lexicon had no case for it.
- **A create can no longer report a post it didn't store.** Post ids are unique
  across tenants; when a new post's id was already held by another tenant's
  post, the write was skipped and the create still answered `200` with the
  id. It now fails with a `500`. Ids are TIDs, so this needed two tenants to
  mint the same id in the same microsecond.

## [0.9.0] — 2026-10-11

The 2026-10-11 decisions that must land before anyone keeps a real post
([`specs/atproto-authority-model.md`](./specs/atproto-authority-model.md) D7–D8,
[`specs/cross-repo-design.md`](./specs/cross-repo-design.md) §3.2 and §3.4).
A reply's StrongRefs and a space post's URI are sealed into every later reply's
CID, so these change now, while the corpus is still wipeable. **Minor**: two of
the three changes are breaking while `0.x`.

Ships with **`@antiphony/shared` 0.9.0**, which was prepared for 0.8.0 and never
published; it gains no new exports or schemas here, only corrected doc comments.

### Changed — BREAKING

- **The author segment of a space URI is the authority's DID** (D8), the
  tenant's app DID, for every post placed in a space:
  `at://{appDid}/space/{type}/{skey}/{appDid}/dev.antiphony.audio.post/{rkey}`.
  It used to be the acting actor's DID when one was asserted
  (`X-Antiphony-Acting-Actor-Did`). The person is the out-of-CID
  `authorId` / `authorDid` facets, as on a flat post. A space post created
  before this release keeps its old URI; a StrongRef naming it by the new shape
  is a `404`, like any URI that doesn't name where a post lives.
- **A reply's StrongRef CIDs are checked** on `POST /api/v1/posts` and XRPC
  `dev.antiphony.audio.createPost`. `reply.parent.cid` must be the parent's
  stored CID and `reply.root.cid` the thread root's, or the request is a `400`
  with `code: REPLY_CID_MISMATCH` (XRPC: the new named error
  `ReplyCidMismatch`). `reply.root.uri` must name the thread's root (the parent
  itself when it's a prompt, else the parent's own `reply.root`), or it's a
  plain `400`. Only the URI and the placement were checked before, so a
  placeholder CID was sealed into the reply.

### Added

- **A reply to a flat post may name a space** (`space: { type, skey }`) on
  `POST /api/v1/posts` and XRPC `createPost` (§3.2). As for a prompt, the space
  must exist for the tenant (`404`) and the audio must be stored in that same
  space (`400`). A reply's placement is at least as restrictive as its
  parent's: a reply to a post in a space still lands in that space, naming any
  other is a `400`, and replies further down the branch inherit it. Without a
  `space`, a reply to a flat post stays flat.

## [0.8.0] — 2026-10-10

atproto **spaces**, Phase 2 ([`specs/spaces.md`](./specs/spaces.md)): a tenant
can create spaces, upload audio and post into them, and that audio plays only
from signed, expiring URLs. **Minor**: everything is additive for a caller that
never names a space, with one behaviour change on the audio proxy, below.

### Added

- **`PUT /api/v1/spaces/{spaceType}/{skey}`** creates a space, or replaces its
  `readPolicy` / `writePolicy` (each `public`, `member-list` or `managing-app`;
  default `member-list`) and optional `managingAppEndpoint`. **`GET`** reads one.
  Service token only; the space's authority is always the caller's app DID, and
  the response's `uri` is `at://{appDid}/space/{type}/{skey}`. A deployment
  without `ANTIPHONY_PLAYBACK_SECRET` answers `503` (`SPACES_UNAVAILABLE`).
- **`POST /api/v1/audio/upload`** takes optional `spaceType` + `skey` form
  fields to store the blob privately in a space (`404` if the tenant has no such
  space), and answers with `space` when the blob is private. The first upload of
  a CID decides its visibility; later uploads of the same bytes never change it.
- **`space: { type, skey }`** on `POST /api/v1/posts` and XRPC
  `dev.antiphony.audio.createPost` (lexicon: `dev.antiphony.audio.defs#spaceKey`)
  places a prompt in a space. `404` for an unknown space; `400` when the audio is
  not stored in that same space, or when a flat post names audio that is.
- **Signed playback.** A spaced post's `embed.audio.url`, and
  `dev.antiphony.audio.getPlaybackUrl` for a private blob, carry `exp` + `sig`
  and expire after an hour. Re-fetch rather than store them.
- **`ANTIPHONY_PLAYBACK_SECRET`** (optional Worker secret, 32+ characters): the
  HMAC key for those signatures. A shorter value fails startup.
- `@antiphony/shared` 0.9.0: `SpaceKeySchema`, `SpacePolicySchema`,
  `SpaceRecordSchema`, `SpaceViewSchema`, `PutSpaceRequestSchema`, and `space`
  on `CreateAudioPostRequestSchema`.

### Changed

- **`GET /api/v1/audio`** answers `404` for private audio without a valid
  signature, and serves it with `Cache-Control: private, max-age=<seconds left>`
  rather than `public, immutable`. Public audio is unchanged, except that an
  unsigned `format=` request now costs one extra storage `head` on the canonical
  blob, checked before any rendition is read or transcoded.
- `dev.antiphony.audio.getPlaybackUrl` no longer promises a stable, unsigned
  URL for every blob: private ones are signed and time-limited, and a deployment
  that can't sign answers `RecordNotFound` for them.
## [0.7.0] — 2026-10-09

Ships with **`@antiphony/shared` 0.8.0** (the package axis; independent of this
contract number). **Minor, not patch**: two changes below tighten validation,
which [`specs/api-versioning.md`](./specs/api-versioning.md) counts as
breaking while `0.x`.

### Changed — BREAKING

- **Timestamps accept only strings and `Date`s.** `TimestampSchema` in
  `@antiphony/shared` (behind `createdAt` on posts and transcripts, and
  `updatedAt` / `leaseUntil` on processing state) no longer accepts the legacy
  Firestore shapes — a `{ seconds, nanoseconds }` object or an object with a
  `toDate()` method — or an epoch-millisecond number. Nothing in Antiphony has
  produced any of them since the move to Postgres: records are stored as JSON
  (ISO-8601 strings) and the wire has always carried ISO strings. In
  `openapi.json`, `createdAt` is now `anyOf: [string, string(date-time)]`.

  **Migration:** a consumer parsing Antiphony responses needs no change. A
  consumer that builds records itself and passes an epoch number or a Firestore
  `Timestamp` must pass `new Date(…)` or an ISO string instead.

- **Request string bounds on `POST /api/v1/posts`** (and the same shapes
  wherever they appear in the document): `StrongRef.uri` is capped at 512
  characters and `StrongRef.cid` at 128; each `langs` entry at 35; `selfLabels`
  at 10 entries of up to 128 characters. JSON bodies on `POST` / `PATCH
  /api/v1/posts` are capped at 256 KB (`413`). A request that parsed before can
  now fail; real values sit far below every cap.

### Changed

- **Out-of-range byte requests on `GET /api/v1/audio`** answer `416 Range Not
  Satisfiable` with `Content-Range: bytes */<size>` (RFC 7233) rather than a
  `206` with an inconsistent `Content-Range`.
- **OpenAPI document regenerated under zod 4 and `@hono/zod-openapi` 1.x.**
  Runtime validation is unchanged by the migration itself; what consumers of
  `openapi.json` see is:
  - parameter `description`s are now emitted on the parameter object as well as
    its schema;
  - the ISO-string member of the timestamp union carries `format: date-time`;
  - URL fields built on `httpsUrl()` (`embed.url`, `rssFeed`) no longer carry
    `format: uri`; the scheme `pattern` is what documents them.

### Fixed

- **The URL `pattern` in `openapi.json` was invalid.** After the zod 4
  migration, `httpsUrl()`'s case-insensitive regex was serialized with its flag
  inside the pattern (`"^https?:\\/\\//i"`), which demands a literal `/i`
  after the scheme and rejects every real URL for a consumer validating against
  the document. The pattern is now `^[Hh][Tt][Tt][Pp][Ss]?:\/\/` — the same
  strings are accepted at runtime as before — and a test fails if any pattern in
  the document carries a regex flag again.

## [0.6.0] — 2026-09-06

URL fields in the contract are restricted to the `http` and `https` schemes.
**Minor, not patch**: this TIGHTENS validation, so a value a consumer's parse
previously accepted can now fail. Under the pre-1.0 rules in
[`specs/api-versioning.md`](./specs/api-versioning.md), tightening a type is a
breaking change.

### Changed — BREAKING

- **`dev.antiphony.embed.audio#view.url` and `dev.antiphony.actor.profile.rssFeed`
  must be absolute `http:`/`https:` URLs.** Both were `z.string().url()`, which
  is `new URL()` underneath and therefore accepts every scheme. All of these
  parsed clean before this release:

      javascript:alert(1)
      data:text/html,<script>alert(1)</script>
      file:///etc/passwd
      vbscript:msgbox(1)

  That is not a cosmetic gap. `url` is the field a client hands to `<audio src>`
  and `rssFeed` is the field an app renders as `<a href>`, so a URL reaching
  either unchecked is a stored-XSS shape — validated once, fired for every
  viewer afterwards. One consumer already declined to trust the published
  contract here and re-narrowed the field on its own side; the point of this
  release is that nobody else has to.

  The rule lives in one place, `httpsUrl()`, newly exported from
  `@antiphony/shared` and `@antiphony/shared/types/url`. It is `.trim()` +
  `.url()` + an `^https?://` anchor checked against the RAW string — the anchor
  rather than a parsed `protocol` because HTML strips tabs and newlines out of
  URL attributes before dereferencing them, so a scheme split by a tab is a live
  `javascript:` URL that `new URL()` parses happily.

  Because the check is a string check rather than a `.refine()`, the schema
  stays a `ZodString`: it still composes with `.extend()`, and the constraint
  now surfaces in `openapi.json` as `"pattern": "^https?:\\/\\/"` instead of
  being invisible to consumers in other languages.

  **`http:` is allowed, deliberately.** `AudioEmbedView.url` is built by
  concatenating `ANTIPHONY_PUBLIC_BASE_URL`, which is `http://localhost:8787` in
  development and for self-hosted deployments. What this closes is scheme
  confusion, not transport confidentiality.

  **Migration:** a deployment already serving `https://…` needs no change. A
  caller storing a non-http(s) URL in `rssFeed` — no legitimate feed does — now
  gets a parse error naming the scheme.

### Added

- **`httpsUrl()`** on `@antiphony/shared` (root export and
  `@antiphony/shared/types/url`), so a consumer that validates its own URL
  fields can reuse the contract's rule instead of restating it.
- **`assertRequiredConfig()` now rejects a non-http(s) `ANTIPHONY_PUBLIC_BASE_URL`**
  at startup. With `url` restricted, a base URL missing its scheme turns every
  post view carrying audio into a hydration failure — the same quiet read-path
  outage the presence check already existed for, so it fails the same way:
  at boot, not per request.
- **`antiphony/no-bare-zod-url`** ESLint rule, on in `packages/shared` and
  `apps/core-api`, banning `z.string().url()`. `types/url.ts` is the single
  audited exception and opts out inline. Two fields shipped to npm with this
  hole; a rule is what stops the third.

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

  A format with no rendition stored is **transcoded on demand** when a
  transcode backend is configured, then served. Without one — a valid state — the
  response is a `404` with a message naming the format, distinct from the audio
  itself being absent, and the renditions that exist are the ones the per-tenant
  processing opt-in pre-warmed.

  The on-demand path is **bounded**: a `(cid, format)` pair costs one transcode
  ever, because the result is cached, and the backend refuses any pair whose
  source blob does not exist. The wait is bounded too — a transcode that does not
  finish inside the request's budget answers `404` and lands for the next
  request, rather than holding the connection open. That matters because the
  consumer this exists for is a Twilio `<Play>` fetch on a live call, where
  waiting is dead air.

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

### Removed

- **Six `/api/v1/system/*` endpoints**, all of them dead code with no caller:
  `POST /system/auth/mint-session-cookie`, `PUT /system/users/{uid}/bluesky-identity`,
  `POST /system/atproto/signin`, `GET|PUT|DELETE /system/atproto-state/{key}`,
  `GET|PUT|DELETE /system/atproto-session/{key}`, and
  `POST /system/rate-limit/check`.

  Each had been re-implemented in the one consuming app's own backend, which had
  also retired its last fallback path to these routes, so nothing called them.
  `POST /api/v1/system/process-audio` — a system-auth'd manual re-drive of the
  processing pipeline — is unaffected and remains the only `/system/*` route.

  Removed with them: `UserService`, the `UserDependencies` port and its Firebase
  binding, `getAdminAuth()`, and the last Firebase Auth usage in the service
  (`createCustomToken`, `createUser`, `deleteUser`, `createSessionCookie`).
  **Antiphony no longer stores a user record** — the `users`, `handles`, and
  `atproto_oauth_states` collections have no writer. Authorship remains the opaque
  `authorId` / `authorDid` facets on a post, unchanged.

  **Not a contract change on its own.** These routes were deliberately plain-Hono
  and never appeared in the OpenAPI document, so `openapi.json` and
  `openapi.surface.json` were byte-identical across the removal. It landed
  between `0.4.0` and `0.5.0` and shipped with `0.5.0`; it is recorded because
  endpoints were removed from the running service, which matters to an operator
  even when it is invisible to the documented surface. See
  [`specs/core-bff-boundary.md`](./specs/core-bff-boundary.md) § Surface disposition.

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
- **`@antiphony/shared` profile leftovers** (published as **0.4.0** — the
  profile/identity trim scoped in `specs/core-bff-boundary.md`):
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
