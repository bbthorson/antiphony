# atproto spaces in Antiphony — implementation plan

**Status:** plan, 2026-09-24. Nothing here is built. Supersedes "Decision 2 —
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
   also unlocks denoise). See open question 2: this interacts with the author
   segment of a space URI.
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
2. **"Upgrade to your own DID" versus a sealed author segment.** A player's
   minted DID goes into the author segment of every spaced record they write, and
   is sealed once replied to. If the paid upgrade means *switching to a
   different DID*, their earlier records stay under the minted one for good. If
   it means *taking control of the minted `did:plc`* (handing the user its top
   rotation key, and repointing it at their own PDS), the DID string never
   changes and nothing is orphaned. This plan recommends the second, and it
   needs agreeing with the did:plc thread before the first kept spaced record.
3. **Blob visibility in the proxy.** One blob CID can be referenced by a public
   post and a spaced one. Choices: derive "public if any flat record references
   it" on upload and on post create; or put spaced blobs under a separate path
   prefix at upload time, which means the upload has to know its space. The
   second is simpler to enforce and costs an upload-API change.
4. **Protocol churn.** The 2026-09-18 policy split shows how quickly the names
   move. Phase 1 models the concepts (space triple, two policies), not wire
   names, so a rename lands in Phase 3's adapter only.

## Non-goals

- Moving public records into spaces, or changing any existing URI.
- Spaces for Vox Pop orgs. Orgs are an app-tier access construct and prompts are
  public by invariant.
- Encryption. Spaces are access control. The host can read the data.
- Nested spaces, or a DID per campaign. A campaign is an `skey`.
