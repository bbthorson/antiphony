# XRPC as Antiphony's API

**Status:** proposal, 2026-10-11. Direction set by Brad on 2026-10-11: **XRPC-first is the end
state, switched at 1.0.** Every Antiphony operation becomes a lexicon method under `/xrpc/*`,
the apps move onto clients generated from those lexicons, and REST (`/api/v1/*`) is deprecated
once they have. Until 1.0 the apps stay on REST. This spec designs the full surface and lists
what is still undecided (§6) and where the wider strategy isn't settled yet (§7).

**Builds on:** [`xrpc-and-atproto-lex-strategy.md`](./xrpc-and-atproto-lex-strategy.md) (the
adapter and lexicon tooling that exist), [`cross-repo-design.md`](./cross-repo-design.md) §2,
[`api-versioning.md`](./api-versioning.md), [`service-auth.md`](./service-auth.md),
[`spaces.md`](./spaces.md).

## 1. Why, and why at 1.0

- **Antiphony is a platform for atproto developers.** They expect lexicons and XRPC, and
  `@atproto/lex` can generate a typed client for any lexicon-described API. One surface, defined
  once, replaces two hand-written clients (Vox Pop's and Bardcast's) and a REST/XRPC pair.
- **Lexicons are meant to be stable.** The Lexicon spec asks for a new method rather than a
  breaking change to a published one. Antiphony is at contract 0.8.0 and still breaks in minor
  versions (spaces this month, the author segment next). REST has `/api/v1/` and 0.x semver to
  absorb that; lexicons don't. So the surface is built out now, and frozen and adopted at 1.0.

## 2. What exists

- **Five methods** in `apps/core-api/src/adapters/inbound/xrpc/`: `dev.antiphony.audio.getPost`,
  `getThread`, `getPlaybackUrl` (queries), `createPost`, `reprocessPost` (procedures). Lexicons in
  `lexicons/dev/antiphony/audio/`, shared shapes in `defs.json`.
- **Contract discipline:** each method touches a lexicon, a Zod schema and a handler together.
  `npm run test:lexicons` validates the documents against `@atproto/lex-document`, and the parity
  test in `@antiphony/shared` holds the Zod schemas to them.
- **Auth:** every method requires a tenant **service token**, the same middleware as REST.
  Procedures also require an acting actor. There is no anonymous access and no atproto service
  auth, so **no outside atproto service can call these today.**
- **Errors:** `{ error, message }`, with the symbol derived from the HTTP status alone
  (`InvalidRequest`, `AuthenticationRequired`, `Forbidden`, `RecordNotFound`, `Conflict`,
  `RateLimitExceeded`, `InternalServerError`). Domain codes such as `AUDIO_PLACEMENT` and
  `SPACES_UNAVAILABLE` are lost.
- **Gaps against REST:** XRPC `createPost` has no idempotency handling (REST's `POST /posts`
  takes `Idempotency-Key`); `createPost` answers a StrongRef `{ uri, cid }` where REST answers
  `{ postId }`.
- **Antiphony has no DID document.** `ANTIPHONY_SERVICE_DID` names it as the `aud` of signed
  service auth, but `https://api.antiphony.dev/.well-known/did.json` is a 404.

## 3. The method inventory

### 3.1 Antiphony's own methods (`dev.antiphony.*`)

| Method | Type | Replaces | Auth tier (§4.1) | State |
| :--- | :--- | :--- | :--- | :--- |
| `dev.antiphony.audio.getPost` | query | `GET /posts/{id}` | tenant; public for flat posts (D-2) | exists |
| `dev.antiphony.audio.getThread` | query | thread reads | tenant; public for flat posts | exists |
| `dev.antiphony.audio.listPosts` | query | `GET /posts` (`kind`, `rootAuthor`, cursor) | tenant | new |
| `dev.antiphony.audio.listReplies` | query | `GET /posts/{id}/replies` | tenant | new, or folded into `getThread` (D-6) |
| `dev.antiphony.audio.createPost` | procedure | `POST /posts` | tenant + acting actor | exists; add idempotency (D-5) |
| `dev.antiphony.audio.reprocessPost` | procedure | `PATCH /posts/{id}` | tenant + acting actor | exists |
| `dev.antiphony.audio.uploadAudio` | procedure, binary input | `POST /audio/upload` | tenant + acting actor | new (D-7) |
| `dev.antiphony.audio.getPlaybackUrl` | query | URL minting | tenant | exists |
| `dev.antiphony.audio.getAudio` | query, binary output | `GET /audio` (proxy) | capability (signed URL) | new, or stays a plain media route (D-8) |
| space management | procedure / query | `PUT`/`GET /spaces/{type}/{skey}` | tenant | new (D-9) |
| `dev.antiphony.tenant.getStats` | query | proposed `GET /stats` ([`tenancy-stats.md`](./tenancy-stats.md)) | tenant | new, if built |
| `dev.antiphony.server.describeServer` | query | `GET /` service info | public | new |

Inputs and outputs reuse `defs.json` (`postView`, `threadView`, `embed` views, `spaceKey`).
Lists use `limit` + `cursor` and answer `{ items, cursor? }` (D-10).

### 3.2 Protocol methods Antiphony serves (spaces Phase 3)

`com.atproto.space.*` (`getDelegationToken`, `getSpaceCredential`, `getRecord`, `listRecords`,
`getBlob`, `listBlobs`, `getLatestCommit`, `getRepo`, `listRepos`, `listRepoOps`,
`registerNotify`, `unregisterNotify`, `notifyWrite`) and `com.atproto.simplespace.getSpace` for
third parties. Antiphony implements these lexicons; it doesn't define them. Their auth is the
protocol's (space credentials, service auth), which is why §4.1 needs more than one tier. Plan:
[`cross-repo-design.md`](./cross-repo-design.md) §4.3.

### 3.3 Methods Antiphony calls

`com.atproto.simplespace.checkUserAccess` on each tenant's managing-app endpoint, and outbound
`com.atproto.space.notifyWrite`. Tenants implement the former, with a helper in the client
package (§5).

## 4. Cross-cutting design

### 4.1 Auth tiers

| Tier | Who | Credential | Methods |
| :--- | :--- | :--- | :--- |
| **Tenant** | Vox Pop, Bardcast, any app with an account | today a service-token bearer; later the app DID's signed service auth (`X-Antiphony-Service-Auth`, now observation-only) | everything in §3.1 |
| **Acting actor** | the tenant's end user, asserted by the tenant | `X-Antiphony-Acting-Actor` (+ `-Did`) on top of the tenant tier | procedures, viewer-scoped reads |
| **Public** | anyone | none | reads of flat (public) records, `describeServer` |
| **atproto service** | another atproto service (AppView, PDS proxying for a user) | atproto inter-service JWT: `iss` a DID, `aud` Antiphony's DID, `lxm` the method | public reads, later anything a tenant delegates |
| **Space credential** | a third-party app reading a space | `Atproto-Space` credential with an HTTP message signature | §3.2 reads |

The tenant tier's acting-actor headers are Antiphony-specific; a generated client needs them
modelled (D-4).

### 4.2 Errors

Each lexicon declares its method's named errors (`errors: [{ name }]`), and the handler emits
those names, not a status-derived symbol: `AudioPlacement`, `SpaceNotFound`,
`SpacesUnavailable`, `ParentNotFound`, `IdempotencyConflict`, and so on, each mapped from today's
REST `code`. The status-derived symbols stay the fallback. Every XRPC error also carries the
`requestId` in a response header, since the body has no slot for it.

### 4.3 Idempotency

`createPost` and `uploadAudio` accept an `Idempotency-Key` header with REST's semantics
(`checkIdempotency` / `saveIdempotencyResult`), so a retried write can't double-post. Headers
aren't part of a lexicon, so the client package sets it (D-5).

### 4.4 Upload

`uploadAudio` takes the raw audio as the request body (`input.encoding: audio/*`) rather than
multipart, as `com.atproto.repo.uploadBlob` does, with an optional space as query parameters
(`spaceType`, `skey`). Limits as today: 25 MB.

### 4.5 Playback

A browser's `<audio src>` can't send auth headers, so playback stays a capability URL: signed
`exp` + `sig` for audio in a space, the bare content address for public audio. Whether that URL
is an XRPC method (`getAudio`, binary output) or remains a plain media route is D-8. Range
requests and `format=mp3` must keep working either way.

### 4.6 Versioning

Lexicons don't version; a breaking change is a new method name. Until 1.0, Antiphony needs a way
to keep changing shapes without publishing broken promises (D-1). At 1.0 the lexicons freeze,
and from then on a breaking change is a new NSID (`createPostV2` style), never an edit. The
OpenAPI contract version keeps describing REST until REST is removed.

### 4.7 Publication and discovery

- **Lexicon resolution:** the `dev.antiphony` authority is `antiphony.dev`. Publishing makes the
  schemas resolvable through a `_lexicon` DNS record pointing at a DID whose repo holds
  `com.atproto.lexicon.schema` records. Antiphony is not a PDS, so that repo needs a home (D-3).
- **Antiphony's service DID:** a `did:web:api.antiphony.dev` document with an `#antiphony` service
  entry and a signing key. It is what atproto service auth is addressed to, and what lets a
  user's PDS proxy calls to Antiphony (`atproto-proxy` header) (D-2).
- **Tenant discovery:** tenants' DID documents already name Antiphony as `#atproto_space_host`.
  Whether they also advertise an XRPC service entry is open
  ([`xrpc-and-atproto-lex-strategy.md`](./xrpc-and-atproto-lex-strategy.md) Phase 3).

### 4.8 One source of truth

Today Zod is the runtime validator and lexicons are held to it by a parity test. With XRPC as
the API, the lexicon becomes the source and Zod the runtime check derived or tested against it
(D-11). Docs follow: the API reference is generated from lexicons instead of OpenAPI (D-12).

## 5. Rollout

| Phase | What | Gate |
| :--- | :--- | :--- |
| **A. Foundations** | Decide D-1 to D-4; Antiphony's DID document; named errors (§4.2); idempotency on `createPost` | none |
| **B. Full surface** | `listPosts`, `listReplies` (or `getThread` paging), `uploadAudio`, space management, `describeServer`; public reads for flat posts | A |
| **C. Client** | `@antiphony/client` generated from the lexicons, with the acting-actor headers, idempotency, the service-auth signer and a `checkUserAccess` helper. Vox Pop and Bardcast adopt it behind their existing gateway seams, calling XRPC | B |
| **D. 1.0** | Freeze the lexicons, publish them (§4.7), switch the docs to lexicons, mark REST deprecated with a removal date | C, and the contract changes in flight (author segment, reply placement) landed |
| **E. Remove REST** | Delete `/api/v1/*` except whatever D-8 keeps for media | D, both apps off REST |

Phase 3 of spaces (§3.2) runs alongside B–D and shares A's auth work.

## 6. Decisions still to make (XRPC)

| # | Decision | Options | Lean |
| :--- | :--- | :--- | :--- |
| D-1 | **Pre-1.0 change policy for lexicons** | (a) edit in place while unpublished and with no external consumers; (b) an `unstable` sub-namespace renamed at 1.0; (c) version suffixes from the start | (a): nothing resolves our lexicons yet, so editing is still honest; publish only at 1.0 |
| D-2 | **Public and service-authenticated reads** | keep every method tenant-only; open public reads of flat posts; also accept atproto service auth | open public reads and service auth: otherwise "XRPC for the protocol" is not true |
| D-3 | **Where the `dev.antiphony` lexicon repo lives** | a small PDS account for `antiphony.dev`'s DID; a hosted PDS; don't publish | a hosted PDS account (no infra to run), at 1.0 |
| D-4 | **Acting actor in the protocol shape** | keep custom headers (client sets them); move into each procedure's input; express as a signed claim inside service auth | keep headers until signed service auth is the credential, then fold the actor into the JWT |
| D-5 | **Idempotency on XRPC writes** | `Idempotency-Key` header; an input field (`clientRequestId`); none | header, matching REST |
| D-6 | **Replies: `listReplies` or paged `getThread`** | separate list method; `getThread` with cursor only | `getThread` already pages; add `listReplies` only if the apps need flat reply lists by filter |
| D-7 | **Upload encoding** | raw body (uploadBlob style); multipart | raw body |
| D-8 | **Playback bytes** | an XRPC binary query; keep a plain media route | keep a media route (it's a capability URL consumed by `<audio>`, not an API call); XRPC mints it |
| D-9 | **Space management names** | `com.atproto.simplespace.createSpace`/`updateSpace`/`getSpace` for tenants too; `dev.antiphony.space.putSpace`/`getSpace` | the protocol's names, if their inputs fit tenant needs (policies as `$type` objects); else `dev.antiphony.space.*` |
| D-10 | **List output shape** | `{ items, cursor? }`; atproto-style named arrays (`{ posts, cursor }`) | named arrays, the atproto convention |
| D-11 | **Source of truth for shapes** | lexicons generate Zod; Zod stays hand-written with the parity test; validate with `@atproto/lex` at runtime | keep hand-written Zod plus parity until 1.0, then generate |
| D-12 | **API docs** | generate from lexicons; keep OpenAPI for REST until removal | both until E, lexicon docs primary from D |
| D-13 | **Rate limits for non-tenant callers** | per IP; per `iss` DID; per space credential | per `iss` for service auth, per IP for public |
| D-14 | **Deprecation window for REST** | fixed date after D; when both apps are off it | when both apps are off it, plus a published date for any third-party tenant |

## 7. Where the wider strategy isn't settled

Collected from the 2026-10-11 design review, beyond XRPC:

**Protocol and identity**
1. **When Phase 3 starts.** Gated on the spaces alpha settling or a second app needing to read a
   space. Neither has a date.
2. **Who hosts Bardcast's app records** (seats, actions, chapters) for third-party readers:
   Bardcast as repo host, or Antiphony generalized beyond `dev.antiphony.*`.
3. **Holding keys:** how Antiphony stores each authority's `#atproto_space` key and the org DIDs'
   operational keys on Workers, and how rotation works.
4. **`did:web` drift detection** ([#117](https://github.com/bbthorson/antiphony/issues/117)) is a
   requirement with no implementation.
5. **NSID roots and their DNS:** `game.bardcast` is still a placeholder and is sealed into every
   campaign URI; `audio.voxpop` and `dev.antiphony` need DNS control and, at publication,
   `_lexicon` records.
6. **Deletion under federation** and **verifiability before Phase 3** (no signed commits yet) are
   deferred to "before the first export" with no plan.

**Product and policy**
7. **What an org gets on export:** replies with opaque ids only, or Vox Pop's id map too.
8. **Paid DID claims:** whether claiming an org's DID is part of a paid tier.
9. **Org handles on Bluesky:** posting from an org's own handle needs a PDS account per org.
10. **Can a replier hear their own reply** through Vox Pop.
11. **Consent copy** on the capture surface ("your reply goes to Acme's team") gates opening any
    org's replies to its members, and isn't written.
12. **Third-party tenants:** there is no self-serve signup; whether outside developers can become
    tenants, and on what terms, decides how much of §4.1's tenant tier needs hardening.
13. **The staff org's DID:** the master account's DID now, a minted one once org minting exists.

**Shared code**
14. **`@antiphony/client` scope:** what moves in from Vox Pop's and Bardcast's clients, and
    whether the fake Antiphony for tests ships with it.
15. **`@antiphony/shared` 0.9.0** is unpublished; Bardcast waits on it.

**Implementation owed now, before any kept post** (decided, not built): the author segment
(D8), replies placed in a space under a flat parent, the parent-CID check, and Bardcast's
placeholder CID.
