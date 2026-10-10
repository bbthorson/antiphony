# atproto spaces in Antiphony — implementation plan

**Status:** plan, 2026-09-24; builds on `@atproto/space` and `@atproto/syntax` since
2026-10-07 (see that update). **Phase 1 is built** (2026-10-07, see "Phase 1 — as built");
Phases 2–4 are not. Supersedes "Decision 2 —
spaces is not adopted now" in [`atproto-authority-model.md`](./atproto-authority-model.md)
(2026-08-21): Brad decided on 2026-09-22 to adopt spaces now, and to prove it on
Bardcast first. That spec is being edited in parallel for the DID-method work,
so this change lives here and the authority-model update can link to it.

**First consumer:** Bardcast. Each campaign is a semi-private space.

## Decisions this plan builds on (settled, not reopened here)

1. **A space's authority is always the tenant's DID** (or an org's DID), never
   Antiphony's. Antiphony is the **space host**, which the tenant's DID document
   already says: the custody check accepts `#atproto_space_host`
   (`apps/core-api/src/lib/app-did.ts`). If Antiphony were the authority, the
   exit-sovereignty argument in the authority model would invert.
2. **Posts published under an org stay with the org.** Org ownership comes from
   the org's DID in the authority position. That is the did:plc /
   multi-authority work, not this plan. Vox Pop prompts are public by
   invariant (vox-pop `specs/organizations.md` §1), so Vox Pop orgs need no
   space to own their posts.
3. **Vox Pop owns audience replies and holds the phone ↔ user-ID layer.**
   Antiphony still never sees a phone number.
4. **DIDs are minted by default; owning your own DID is a paid upgrade** (which
   also unlocks denoise), and the upgrade is a claim of the minted DID, not a
   switch. See open question 2 for why that matters to the author segment.
5. **The corpus is still wipeable.** Reply StrongRefs seal a parent's URI into
   the reply's CID at write time, so URI shape is free to change now and
   impossible to change later.

## What the protocol says today (checked 2026-09-24)

Spaces is alpha. Treat every name below as liable to move, and re-check before
each phase starts.

- **Address:** `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
  A space is the triple *(authority DID, space type NSID, skey)*. The author is
  a path segment, not the authority.
- **Roles:** the *space authority* (the DID) issues space credentials
  (`getSpaceCredential`), describes the space (`getSpace`), lists writers, and
  routes `notifyWrite`. The *space host* is the service that runs those
  functions for the authority. *Repo hosts* hold each author's records.
- **Policies — changed 2026-09-18.** The single `policy` field split into
  **`readPolicy`** (gates credential minting) and **`writePolicy`** (gates
  whether the authority tracks a writer and forwards `notifyWrite`). Each is one
  of `public`, `member-list`, `managing-app`; the default is `member-list`, and
  hosts must reject values they don't implement.
- **`managing-app`:** the host never makes the membership decision itself; it
  calls the managing app's **`checkUserAccess`**, which now takes a required
  `access: "read" | "write"`. On write checks `clientId` is omitted.
- **Membership:** `addMember` became **`putMember`**, which sets `read` and
  `write` booleans together.
- **Still true:** access control, not encryption. The host and every admitted
  app can read the data.

Sources: the alpha announcement (atproto.com/blog/atproto-spaces-alpha), the
2026-09-18 spec-delta summary tracked in the `ezpds` project, and the
`rsky-space-host` crate docs. Proposal 0016 is the design lineage.

## Update 2026-10-07 — build on the atproto libraries

Decided by Brad: use Bluesky's own spaces code rather than hand-rolling the protocol. Two
packages, both alpha, **pinned to an exact version** and upgraded deliberately:

- **`@atproto/space`** `0.0.0-spaces-alpha-20261001173819`, the protocol primitives:
  space tokens (`createSpaceToken`, `parseSpaceToken`, `verifySpaceToken`, the `delegation`,
  `credential` and `clientAttestation` types), HTTP message signatures (`createSpaceSig`,
  `verifySpaceSignature`), space repo commits (`RepoCommit` over an `LtHash` set hash,
  `verifyCommit`) and sync (`serializeRepo`, `verifyRepoCar`). It is not a host: there is no
  server, store or policy engine in it.
- **`@atproto/syntax`** at the same alpha, for space URIs: `AtUri.makeSpace(spaceDid,
  spaceType, skey, authorDid?, collection?, rkey?)`, `AtUri#isSpace`, `#spaceDid`,
  `#spaceType`, and `SpaceRef` for a space itself (`at://{spaceDid}/space/{type}/{skey}`).

**Why pin exactly.** The alpha already broke once: between the 2026-08-18 and 2026-10-01
builds, credentials moved from DPoP binding to HTTP message signatures over the token and an
audience DID (atproto #5569). A caret range on a `0.0.0-…` prerelease would take the next
break silently.

**What that changes per phase:**

| Phase | What the libraries cover | What stays Antiphony's |
| :--- | :--- | :--- |
| 1 — data model and URIs | Building, parsing and validating space URIs (`AtUri.makeSpace`, `SpaceRef.parse`). The hand-written builder and parser below become thin wrappers over them, with the flat shape unchanged. | Placement on the post row, the tenant check in the parser, the `@antiphony/shared` schema. |
| 2 — tenant API and enforcement | Nothing. | All of it: the spaces API, prompts in a space, replies inheriting, and **signed playback** (below). |
| 3 — protocol surface | Most of it: issuing and verifying credentials, verifying request signatures, the space repo commit and its sync format. | Routing, storage, `checkUserAccess` calls, and holding the space signing key (open question 1). |

Phase 3 gets much smaller, but it stays after Phase 2: no app other than the tenant needs to
read a space yet.

**Who can play a recording.** Today nobody needs a DID or any credential to play one:
`GET /api/v1/audio` is an anonymous proxy, and since 0.5.0 its URLs are stable and unsigned
(`apps/core-api/src/lib/audio-url.ts`). The gate is Phase 2's signed playback. A tenant asks
for a short-lived URL after making its own access decision; for Bardcast that means checking
the player's session DID against the space's membership (the campaign's party, or the player
themselves for their own space). Phase 3 credentials don't replace this for playback: a
browser's `<audio src>` can't attach an HTTP message signature, so signed URLs stay the way
audio is played.

**Dependencies.** `@atproto/space` depends on `zod` 3 while Antiphony is on `zod` 4, so both
copies end up in the Worker bundle. That's acceptable; never pass a schema across the boundary.

**Checked on Workers, 2026-10-07.** A probe Worker under core-api's own settings
(`compatibility_date` 2025-11-01, `nodejs_compat`) minted and verified a space credential,
signed and verified a request (`createSpaceSigHeaders` / `verifySpaceSignature`), signed and
verified a space repo commit, and round-tripped a space URI with a DID as its `skey`. Two
findings for whoever adds `@atproto/space` (Phase 3):

- **It can't be installed as published without `overrides`.** Its `@atproto/*` dependencies
  are declared `^0.0.0-spaces-alpha-…`, and a caret range on a `0.0.0` prerelease also
  matches the plain `0.0.0` release. `@atproto/lex-data@0.0.0` and `@atproto/lex-cbor@0.0.0`
  exist, and `lex-data@0.0.0` was published with a raw `"@atproto/syntax": "workspace:*"`
  dependency, so npm 10 and 11 die silently mid-resolve and pnpm reports
  `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. Add root `overrides` pinning `@atproto/lex-data`,
  `@atproto/lex-cbor`, `@atproto/car`, `@atproto/crypto`, `@atproto/common` and
  `@atproto/syntax` to the same exact alpha.
- **It needs `nodejs_compat`**: `multiformats`' sha2 imports Node's `crypto`. core-api already
  has the flag.

`@atproto/space` is not a dependency yet: nothing calls it before Phase 3, and `knip` rejects
an unused dependency. `@atproto/syntax` is, at the exact alpha, in both `packages/core` and
`apps/core-api` (one version, replacing `^0.7.6`; core-api only used its TID, record-key and
DID validators, which the alpha keeps). Its own dependencies don't hit the `0.0.0` trap.

## Shape of the change

### Visibility belongs to the space, not the record

The coordinator brief asked for "a visibility dimension on records". The
protocol answers that more precisely, and the plan follows it:

- A record is either **flat** (today's `at://{appDid}/{collection}/{rkey}`) or
  **placed in a space**.
- **Flat means public.** Public records stay in the flat shape permanently; they
  do not migrate into a `public` space. That is how public data lives on atproto
  anyway, and it means **no existing URI changes**. Vox Pop prompts stay flat by
  invariant.
- **A spaced record's visibility is its space's `readPolicy`.** It is not a
  field on the record. Changing who can see a campaign's audio is a policy edit
  on the space, which is reversible. Moving a record between spaces changes its
  URI, which a reply's StrongRef has already sealed, so a post's space is fixed
  at creation.

So records gain a **placement** (`space: { type, skey } | null`), and effective
visibility is resolved from it. A per-record `visibility` enum would duplicate
the space's policy and could disagree with it.

### Space placement is out of the CID

The canonical record (`canonicalPostRecord`, `packages/core/services/audio-posts.ts`)
does not change. Placement is location, like the authority, and the protocol
carries location in the URI rather than in the record. Identical content in two
spaces keeps one content CID, the same property the authority model relies on
for re-homing.

### The author segment

A space URI requires `{authorDid}`. The rule:

- **The acting actor has a DID:** it goes in the author segment. For Bardcast
  this is always true, since characters are keyed on the player's DID.
- **The acting actor has no DID:** the tenant's app DID goes there. This is
  Model B preserved inside a space, and it keeps that author's identity a
  reassignable facet.

The segment is sealed the moment the record is replied to. `authorId` /
`authorDid` stay facets beside it, unchanged.

### Replies inherit the parent's space

A reply is created in its parent's space, always. The request may not name a
different one. Otherwise a public reply to a private post would publish part of
a private conversation, and a spaced reply to a flat prompt would be invisible
in its own thread. `resolveReplyBranch` already fetches the parent, so the
placement comes free.

## Phases

Each phase ships on its own and leaves the service working.

### Phase 1 — data model and URIs (Antiphony)

- **Migration `0002`:** a `spaces` table keyed by
  `(origin_app_id, space_type, skey)`, with `read_policy` and `write_policy`
  (both columns from the start, per the 2026-09-18 split) and
  `managing_app_endpoint`. `posts` gains nullable `space_type`, `skey`,
  `author_segment`, and a check constraint that they are all set or all null.
  The authority is not stored per row: it is the tenant's pinned DID, looked up
  through `getAppDid` as today.
- **URI builder:** replace `buildPostUri(appDid, rkey)` with one builder over
  `{ authority, space?, authorSegment?, collection, rkey }`. Flat output is
  byte-identical to today's. Every caller (`hydrateAudioPosts`, `hydrateOne`,
  the transcript `subject.uri` in `audio-processing.ts`, XRPC `createPost`) goes
  through it.
- **URI parser:** `parsePostId` accepts both shapes, and still rejects any URI
  whose authority is not the caller's tenant DID. For a spaced URI it also
  returns the space triple, so a reply can be checked against its parent.
- **Validation:** `spaceType` as an NSID, `skey` as atproto record-key syntax.
  Check `skey` against the live lexicon before shipping.
- **Zod:** `AudioPostRecordSchema` gains the optional placement in
  `@antiphony/shared`. That is a contract change: a minor version bump, and Vox
  Pop's exact pin stays on the old version until it chooses to move.
- **Tests:** a flat round trip is unchanged; a spaced round trip; a reply to a
  spaced parent lands in the same space; a request naming a different space is
  rejected; a spaced URI from another tenant is rejected.

### Phase 1 — as built (2026-10-07)

What landed, and where it differs from the plan above:

- **Migration `0002_spaces.sql`.** The `spaces` table as planned, keyed by
  `(origin_app_id, space_type, skey)`, with both policies (defaulting to the protocol's
  `member-list`, checked against the three known values) and a **nullable**
  `managing_app_endpoint`: the tenant is its own managing app and tenant reads need no
  callback, so only Phase 3 needs it set. On `posts`, `space_type`, `skey` and
  `author_segment` are **generated columns** promoted from `record -> 'space'`, like 0001's
  query facets, with the all-or-none check. Beyond the plan: a **foreign key** to `spaces`
  (a placed post's space must exist in the same tenant; a space holding posts can't be
  deleted) and a partial index for listing a space's posts.
- **Placement is one object on the record**: `space: { type, skey, authorSegment }`
  (`SpacePlacementSchema` in `@antiphony/shared`, now **0.8.0**), storage-layer and out of the
  CID. One object rather than three optional fields makes all-or-none structural in Zod too.
  Shared keeps light syntax checks so it stays dependency-free; core validates every part with
  `@atproto/syntax` before minting a URI.
- **URIs.** `buildRecordUri({ authority, collection, rkey, space? })` is the one builder;
  `buildPostUri(appDid, rkey, space?)` wraps it, so every caller passes the record's own
  placement (hydration, transcript subjects, XRPC `createPost`). Flat URIs are still built by
  hand, byte-identical; space URIs come from `AtUri.makeSpace`. `parsePostUri` returns the id
  and placement, refuses another tenant's authority as before, and refuses a space URI this
  service wouldn't have minted (it must round-trip). `parsePostId` wraps it.
- **Placement through `createPost`.** A prompt can name `space: { type, skey }`; the author
  segment is the author's DID, or the tenant's app DID when they have none. A reply always
  lands in its parent's space; naming any other space is a 400. A parent URI whose placement
  doesn't match where the parent actually lives is treated as a missing parent (404).
- **`packages/core` moved to `moduleResolution: bundler`** (with `module: esnext`), matching
  the root and core-api. The old `node` resolution can't read `@atproto/syntax`'s `exports`
  map. Nothing consumes core's `dist`; every consumer reads its source.
- **Not yet (Phase 2, since built):** no route accepts `space`, so nothing outside tests can
  place a post, and spaces exist only by SQL. A service call naming a space that doesn't exist
  fails at save on the foreign key (a 500) until Phase 2 checks it first. Playback is still
  anonymous.
- **Tests:** `packages/core/services/audio-posts.spaces.test.ts` (URI shapes and round trips,
  a DID as `skey`, cross-tenant and malformed URIs, placement through create, reply
  inheritance and its refusals, hydration), `apps/core-api/src/adapters/outbound/postgres/spaces.test.ts`
  (placement round trip, the generated columns, the foreign key, the all-or-none check, policy
  values, deletion), and `SpacePlacementSchema` cases in `@antiphony/shared`.

### Phase 2 — the tenant API and enforcement (Antiphony)

- **`PUT /api/v1/spaces/{spaceType}/{skey}`** creates or updates a space's
  policies. **`GET`** reads one. Both are scoped to the calling tenant, so the
  authority is always the caller's own DID. XRPC mirrors come after, following
  `specs/xrpc-and-atproto-lex-strategy.md`.
- **`POST /posts` and XRPC `createPost`** accept `space: { type, skey }` on a
  prompt. The space must exist and belong to the tenant.
- **Reads through the tenant need no callback.** Under `managing-app` the
  tenant *is* the managing app, so when it calls with its own service token and
  asserts a viewer, it has already made the access decision. Calling its own
  `checkUserAccess` back would be a round trip to the same answer. Tenant reads
  behave as they do today.
- **The audio proxy is the real gap.** `GET /api/v1/audio` is anonymous and
  serves any path under `blobs/{originAppId}/{cid}` (`adapters/inbound/rest/audio.ts`).
  A spaced post's playback URL is a stable, unauthenticated link, so anyone it
  leaks to can play the audio. For a record whose space is not `public`, the
  hydrator issues a short-lived signed playback URL, and the proxy refuses the
  bare path for any blob that only spaced records reference. How to know a
  blob's visibility without a per-request join is open question 3.
- **Webhooks and enrichment** already go only to the owning tenant, so they need
  no change.

### Phase 2 — as built (2026-10-08)

API contract 0.8.0 (`CHANGELOG.md`).

- **Spaces API.** `PUT`/`GET /api/v1/spaces/{spaceType}/{skey}` (`adapters/inbound/rest/spaces.ts`),
  behind a service token alone: managing the tenant's own spaces needs no acting actor.
  `PUT` replaces the policies (an omitted one goes back to `member-list`) and is idempotent.
  `SpaceService` (`packages/core/services/spaces.ts`) validates the type and key with
  `@atproto/syntax` and builds the space's own URI with `SpaceRef`; the Postgres adapter is
  one upsert. Another tenant's space reads as 404. XRPC mirrors are still to come.
- **Upload into a space.** `POST /api/v1/audio/upload` takes optional `spaceType` + `skey`
  form fields. The space must exist (404). The object's custom metadata then carries
  `antiphony-space: {type}/{skey}` (`apps/core-api/src/lib/blob-space.ts`); its path is
  unchanged. **The first upload wins:** a CID already stored is never rewritten, so
  re-uploading the same bytes can neither expose private audio nor hide public audio. The
  response's `space` says where the blob actually lives. A marker that can't be read is
  treated as private (fail closed).
- **Posts.** `POST /api/v1/posts` and XRPC `createPost` take `space: { type, skey }` on a
  prompt; the space must exist for the tenant (404, where Phase 1 failed on the foreign
  key with a 500). The audio must match the post (400 otherwise): a post in a space needs
  audio stored in that same space, and a flat post can't use audio stored in one. Audio the
  store has never seen is allowed on a flat post, as before. Derived blobs from processing
  inherit the post's space.
- **Signed playback.** Audio in a space plays only from the proxy URL plus `exp` (Unix
  seconds) and `sig`, an HMAC-SHA256 over `antiphony-playback-v1\n{objectPath}\n{exp}`
  keyed by `ANTIPHONY_PLAYBACK_SECRET` (`apps/core-api/src/lib/playback-signature.ts`),
  valid for an hour. Hydration (`AudioEmbedView.url`) and `getPlaybackUrl` mint it; the
  tenant decides who sees the view, which is the managing app's decision. Every spaced
  post is signed, whatever its space's read policy, including `public`: one rule, and
  a public space costs only a URL that expires. `format` is not signed, so a holder of
  the URL can append `format=mp3`.
- **The proxy.** Unsigned (or expired, or tampered) requests for private audio get 404, the
  same as missing audio. The canonical read already carries the metadata, so that check
  costs nothing; for `format`, the proxy stats the canonical blob first, before any
  rendition read or transcode, because a rendition object has no marker of its own. That's
  one extra R2 `head` on an unsigned rendition request, public ones included. Private
  responses are `Cache-Control: private, max-age={seconds left on the signature}`; public
  ones stay `public, immutable`.
- **Fails closed without a secret.** The secret is optional (32 characters minimum when
  set). Without it `PUT /spaces` is a 503 (`SPACES_UNAVAILABLE`), so a deployment can't
  store private audio it couldn't serve, and if it's removed later, spaced audio gets no
  URL rather than an unsigned one.
- **Not yet.** Read policies other than "the tenant decides" are stored but not enforced
  by Antiphony: that's Phase 3, along with the protocol surface. A signed URL can't be
  revoked before it expires. Rotating the secret invalidates every outstanding URL.
- **Tests:** `rest/spaces.test.ts`, the private-audio suite in `rest/audio.test.ts`,
  "into a space" in `rest/audio-upload.test.ts`, the signed `getPlaybackUrl` cases in
  `xrpc/index.test.ts`, `lib/playback-signature.test.ts`, the metadata cases in
  `r2/blob-store.test.ts`, the adapter and signing cases in `postgres/spaces.test.ts`,
  and "audio placement (Phase 2)" in `packages/core/services/audio-posts.spaces.test.ts`.

### Phase 3 — protocol surface (Antiphony, deferred)

Serve the space-host side of the protocol, so an app *other* than the tenant
can read a space with a credential: `getSpace`, `getSpaceCredential`,
credentialed record reads, the outbound **`checkUserAccess`** call to the
tenant's `managing_app_endpoint` (with `access: "read"` or `"write"`), and
`notifyWrite`. This is the only phase that talks to the moving parts of the
alpha, so it waits until spaces leaves alpha or a second app actually needs to
read a space. Phases 1 and 2 give Bardcast everything it needs without it.

### Phase 4 — Bardcast consumer (bardcast repo)

- **Space type:** an NSID under Bardcast's root, from
  `packages/domain/src/nsid.ts`, e.g. `game.bardcast.space.campaign`. The
  `game.bardcast` root is still a placeholder there, and the space type is
  sealed into every campaign URI, so pick the real root before the first kept
  campaign.
- **skey:** the campaign record's rkey.
- **Policy:** `readPolicy: managing-app`, `writePolicy: managing-app`. The
  orchestrator's own campaign membership is the answer, which is what a
  semi-private campaign means.
- **Wiring:** `AntiphonyGateway` gains `ensureSpace(campaign)`; `publish-prompt`
  passes the campaign's space; player replies inherit it from the parent with no
  change on Bardcast's side. `postIdFromUri` (last segment) already works for
  space URIs.
- **A second space type: a private space per player** for character-creation recordings, which
  happen outside any campaign (decided 2026-10-07,
  [`atproto-authority-model.md` D6](./atproto-authority-model.md#d6--bardcast-characters-2026-10-07)).
  Type `game.bardcast.space.player`, `skey` the player's DID, `managing-app` policies, created
  when the player starts their first character. Nothing in Phases 1–3 assumes one space type per
  tenant.
- **Tenancy first:** Bardcast is not a tenant in production yet (only Vox Pop is
  pinned in `ANTIPHONY_APP_DIDS`). That onboarding is item #1 in the authority
  thread, which Brad parked. Phase 4 cannot run against production until it is
  done. It can run against a local deploy.

## Open questions

1. **Who signs space credentials (Phase 3).** If a credential has to be signed
   by a key in the authority's DID document, Antiphony holds a signing key for
   the tenant's DID. That is the same shape as the lower-priority operational
   key in the did:plc plan, and it should be designed together with it. It does
   not block Phases 1, 2 or 4.
   *Narrowed 2026-10-07 by `@atproto/space`:* credentials are signed with the
   authority's `#atproto_space` key when its DID document publishes one, and its
   `#atproto` key otherwise. So Antiphony never needs the tenant's account key: the
   tenant publishes a dedicated `#atproto_space` key, next to the
   `#atproto_space_host` entry it already adds, and Antiphony holds that one.
2. **"Upgrade to your own DID" versus a sealed author segment — settled.** A
   player's minted DID goes into the author segment of every spaced record they
   write, and is sealed once replied to. That is safe only because the paid
   upgrade is a *claim* of the minted `did:plc` (the user takes its top rotation
   key), never a switch to a different DID, so the DID string never changes.
   Bringing an existing DID is supported at signup only, before anything is
   written under a minted one.
   Brad settled this on 2026-09-24; the mechanism is in
   `specs/did-plc-and-multi-did-tenancy.md` (PR #159). If that ever changes to
   a switch, spaced records written before it stay under the old DID for good.
3. **Blob visibility in the proxy.** One blob CID can be referenced by a public
   post and a spaced one. Choices: derive "public if any flat record references
   it" on upload and on post create; or put spaced blobs under a separate path
   prefix at upload time, which means the upload has to know its space. The
   second is simpler to enforce and costs an upload-API change.
   *Settled 2026-10-08 (Phase 2):* the upload names its space, as the second
   choice has it, but the mark goes in the object's R2 custom metadata, not in
   its path, so renditions, processing and the transcode container are
   untouched. One CID is one object, so it has one visibility: the first upload
   decides it, and post creation refuses a post whose audio lives somewhere
   else. See "Phase 2 — as built".
4. **Protocol churn.** The 2026-09-18 policy split shows how quickly the names
   move. Phase 1 models the concepts (space triple, two policies), not wire
   names, so a rename lands in Phase 3's adapter only.

## Non-goals

- Moving public records into spaces, or changing any existing URI.
- Spaces for Vox Pop orgs. Orgs are an app-tier access construct and prompts are
  public by invariant.
- Encryption. Spaces are access control. The host can read the data.
- Nested spaces, or a DID per campaign. A campaign is an `skey`.
