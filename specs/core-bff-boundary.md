# Core ↔ BFF boundary (the seam)

**Status:** proposed 2026-07-03; **implemented, with one correction 2026-08-16.** The
"B3" trim described below executed — the profile/handle/identity surface was removed
from core, and the Vox Pop BFF that owns it is now an **independent repository**
composing against this seam over HTTP. Retained as the decision record: the principle
table and the join contract are the durable value; the "What B3 executes" / "Coupled
BFF work" sections are historical now that both sides shipped.

> ⚠️ **This doc claimed the `/system/atproto-*` + `/system/auth` block was removed
> from core for roughly six weeks while it was still mounted** — see § Surface
> disposition, which keeps the record rather than quietly erasing it. The BFF's
> *dependency* on those routes had been removed; the routes had not. They are now
> genuinely deleted, along with `UserService` and the last Firebase Auth usage.
> The public trim (`/users/*`, `/resolve/*`, `/atproto/disconnect`) had fully executed
> all along.

Companion to
[`service-auth.md`](./service-auth.md) (the auth half), [`docs-content-scope.md`](./docs-content-scope.md)
(the docs half), and [`atproto-authority-model.md`](./atproto-authority-model.md) (the
identity/authority axis — **resolved** to app-as-repo-owner; read it first).

> **Superseded on one axis — the Actors surface.** This doc argued the actor↔DID
> mapping (`/api/v1/actors/register`, `GET /{actorId}`, `ActorIdentityRecord`)
> *stays in core*. [`core-surface.md`](./core-surface.md) (Decided 2026-07-05) reversed
> that: the DID is asserted **per request** (`X-Antiphony-Acting-Actor-Did`), not
> registered, so the Actors routes, service, and `types/actor-identity.ts` were
> **removed**. Authorship attribution now lives entirely on the post as the opaque
> `authorId` / `authorDid` facets — there is no stored actor record. Read the
> `actor↔DID` references below with that correction in mind.

## The principle

Antiphony is a **headless store for AT-Protocol-shaped audio posts + audio hygiene**.
It knows *content*, *tenancy*, and *custody*; it does not know *people's presentation*.

| Antiphony core owns | The calling BFF owns (Vox Pop) |
| :--- | :--- |
| Audio posts (`dev.antiphony.audio.post`), threads, reply gating | End-user **profiles** — display name, bio, avatar, tiers, settings |
| Blobs (content-addressed), signed playback URLs, transcripts | **Handle** claiming, uniqueness, availability, sitemap enumeration |
| Tenancy (`originAppId`) + the **app DID** (repo authority, per tenant) | The **OAuth ceremony** (authorize/callback) + end-user session machinery |
| Authorship attribution — the opaque `authorId` / `authorDid` facets stamped on each post (no stored actor record; see the superseding note above) | The rich actor profile + any product enrichment |
| Service-to-service auth (`ANTIPHONY_APP_TOKENS`, acting-actor headers) | End-user auth (verifies its own users, then *asserts* the acting actor) |

The join key across the seam is the **actor id**: the BFF asserts it via
`X-Antiphony-Acting-Actor`, core stamps it as `authorId` on posts (authorship *attribution*
— the `at://` *authority* is the app DID, per the authority model), and the BFF joins its
own profile store back onto core's posts by that same id. Core never returns profile
fields; the BFF never sends core a profile.

## Surface disposition

### REST endpoints

**Keep (core contract):**

- `POST/GET /api/v1/posts`, `GET /api/v1/posts/{postId}`, `GET /api/v1/posts/{postId}/replies`
- `GET /api/v1/audio`, `POST /api/v1/audio/upload`
- ~~`POST /api/v1/system/rate-limit`~~ — **removed 2026-08-16.** Listed here as a
  service-to-service helper so the BFF could rate-limit without touching Firestore;
  Stream 4 F7 **G2** moved the check endpoint onto the Vox Pop BFF, which serves it
  itself (`packages/bff-client/rate-limit.ts` resolves only `VOXPOP_API_BASE_URL`),
  leaving this one caller-less. Deleted with the block below.
  **Note the distinction:** the *route* is gone, but `checkRateLimit()` — the function
  behind it — is still what every `rateLimit(...)` middleware in core calls in-process.
  The function stays; only the HTTP surface went. A useful side effect: nothing external
  shares these buckets any more, so where they live became a purely internal decision.

*(The `/api/v1/actors/*` mapping this doc originally listed here was removed — see the superseding note at the top; attribution is now the per-request `authorId` / `authorDid` on posts.)*

**Moved to the BFF — ✅ removed from core** (was "remove in B3"):

- All of `/api/v1/users/*` — `GET /users`, `/users/handles`, `/users/{handle}`,
  `/users/{handle}/profile`, `GET|PATCH /users/me`, `/users/me/handle`,
  `/users/me/handle/available`, `POST /users/me/delete`. This is the profile + handle
  surface end-to-end.
- `GET /api/v1/resolve/{handle}` — handle→profile resolution is a profile concern (core
  keeps handle only as a non-authoritative display snapshot; see below).
- `POST /api/v1/atproto/disconnect` — mutates the user profile's linked identity.

**Re-homed in the BFF — ✅ now actually removed from core** (2026-08-16):

⚠️ **These were listed as removed for roughly six weeks while still mounted.** The
claim was made when Vox Pop finished re-homing them, but the two states look identical
from that side and are opposite problems here:

> The BFF's **dependency on** these routes was removed. The routes themselves were not.

The distinction is recorded rather than quietly fixed because it is the failure mode
this doc is most prone to: a boundary is only half-moved when one side stops calling,
and marking it done at that point leaves dead privileged endpoints serving. They are
now genuinely deleted from [`app.ts`](../apps/core-api/src/app.ts) and the tree.

- `POST /api/v1/system/auth/mint-session-cookie` — end-user session machinery.
- `PUT /api/v1/system/users/{uid}/bluesky-identity` — profile-identity mutation; the BFF owns identity linking.
- `POST /api/v1/system/atproto` (signin), `/system/atproto-state/*`, `/system/atproto-session/*`
  — server-side backing for the OAuth ceremony; the BFF holds its own OAuth state/session.

Vox Pop ported its own copies and cut over: `specs/archive/stream4-f7-execution.md`
there records **A1** (#722 — atproto state + session stores), **A2** (bluesky-identity
+ signin, with `apps/web` repointed), and **G1** (`system-auth-mint.ts` ported verbatim
and mounted on the BFF). The `CORE_API_BASE_URL` fallback that G1 left behind — the one
live path back to core — was **retired in E2**; nothing in that repo resolves it today.
Vox Pop has since moved past the surface entirely, verifying Ed25519 session JWTs
against its own JWKS.

They were 100% of core's remaining **Firebase Auth** usage (`createCustomToken`,
`createUser`, `deleteUser`, `createSessionCookie`) and the sole owners of the `users`,
`handles`, and `atproto_oauth_states` collections — which is why deleting them was the
first step of [`cloudflare-migration.md`](./archive/cloudflare-migration.md) rather than a
tidy-up. Gone with them: `UserService`, the `UserDependencies` port, its Firebase
binding, and `getAdminAuth()`. **Antiphony now holds no user record at all** —
authorship is the opaque `authorId` facet on a post and nothing more, which is exactly
what the principle table above describes.

The public API surface is byte-identical across the deletion (`openapi.json` and
`openapi.surface.json` both unchanged), confirming these were always outside the
documented contract.

Rationale for the whole `/system/atproto-*` + `/system/auth` block: the OAuth ceremony is
product UX tied to the calling app's origin (its callback URL is registered with the PDS),
so both the flow **and** its server-side state belong to the app. Core held them only
because a browser (the app's web client) can't; a BFF can.

### Shared types (`@antiphony/shared` — the breaking 0.4.0 trim)

**Remove:**

- `types/views.ts` — `ProfileViewBasic/Detailed/Self/Admin`, `ProfileViewSchema`, `toProfileViewBasic`.
- `types/api.ts` — `PublicProfileDto` (extends `ProfileViewBasic`; goes with it).
- `UserRecordSchema` (in `types/records.ts`) — the legacy `users`-collection record.

**Change (breaking — the seam-defining edit):**

- `AudioPostView.author` (`types/audio.ts:272`) currently embeds `ProfileViewBasicSchema`,
  i.e. **core post views leak full author profile data today**. Post-seam, core must not.
  Replace with an identity-only author: **`{ id, did? }`** (resolved below).

**Keep:** `types/audio.ts` (minus the author change), `types/processing.ts`,
`types/blob.ts`, `types/records.ts`, `api-codecs.ts`, `nsid`, `errors`, `utils`,
`observability`. (`types/actor-identity.ts` was **removed**, not kept — see the
superseding note at the top.)

## The join contract

The one part of the seam the fork blueprint does *not* already answer, because in the
original monolith author + profile were the same object.

### Post views expose identity, not profile

Core post views carry `authorId` (required) and `authorDid` (optional) — both already
storage facets on `AudioPostRecord` — and **nothing else about the person**. No display
name, bio, avatar, and **no handle**. The author projection is exactly `{ id, did? }`. The
BFF renders an author by joining `authorId` against its own profile store.

**Why no handle on the view** (resolved 2026-07-03): the DID is canonical and stable; the
handle drifts (Bluesky handles change — the same volatility the actor↔DID record calls
out). A handle snapshot on an otherwise-stable post view is a staleness trap. The BFF owns
the *authoritative current* handle and resolves it fresh at render time, so core never
ships a stale one.

**"All posts by an actor" does not depend on this.** That feed is served by the `authorId`
facet (a cheap composite-index query — the reason `authorId` is indexed at all), which
stays in core regardless. Author *identity* travels with the post (`authorId`/`authorDid`);
author *presentation* (name/avatar/handle) is always a BFF join.

### Handle authority

Core stores `handle` only as a **non-authoritative display snapshot** on the actor record.
Claiming, uniqueness enforcement, availability checks, and the handle→actor index are the
**BFF's** — which is why `/resolve` and `/users/*/handle*` move out. If two tenants'
actors share a handle string, that's fine at the core layer; the BFF's namespace is where
uniqueness means something.

### actor.profile lexicon

`types/audio.ts` also defines `ActorProfileRecordSchema` (`dev.antiphony.actor.profile`, a
port of `com.voxpop.actor.profile`). It is a *portable record schema*, not an endpoint, and
`docs-content-scope.md` lists `actor.profile` among the core lexicons. But its **content is
profile data** (display name / bio / avatar — the thing we're moving to the BFF).

**Resolved (2026-07-03): keep the schema, drop core storage.** The lexicon *definition*
stays in `@antiphony/shared` — it's a portable AT-Proto record shape, cheap to keep, and
the well-known form to project into if we ever federate/export an actor. But core does
**not** store, serve, or CRUD `actor.profile`: the BFF is the sole authority for profile
data. If federation ever matters, core projects the BFF-owned profile into this shape at
export time. The failure mode we're avoiding is core keeping its *own* copy that silently
drifts from the BFF's authoritative one. (Note the author-feed use case — "all posts by
actor X" — is served by the `authorId` facet and needs none of this.)

## Auth seam

Fully specified in [`service-auth.md`](./service-auth.md); not restated here. Two notes for
B3:

- DID/actor *registration* was ultimately **not** built as a core surface — the DID is
  asserted per request instead (`X-Antiphony-Acting-Actor-Did`). See the superseding note
  at the top.
- The **end-user Firebase fallback** that this doc flagged "don't cut yet" has since been
  **removed** — the service token is now the only accepted credential (`service-auth.md`),
  and every data route is gated. There is no tokenless/end-user path left.

## What B3 executed — ✅ done

1. **Delete** the moved routes (above) and their handlers/tests; unmount from `app.ts`.
2. **Breaking `AudioPostView.author` change** — `ProfileViewBasic` embed → `{ id, did? }`.
   Both fields are already on `AudioPostRecord` (`authorId`/`authorDid`), so this also
   **removes `getAuthorsByIds` from `AudioPostDependencies`** and the profile-fetch in
   hydration (`audio-posts.ts:301-302,353`) — one fewer dependency and one fewer DB query.
3. **Trim `@antiphony/shared`** (views/api/UserRecord) → **0.4.0** (major; breaking).
   - **Cross-repo prerequisite:** the Vox Pop BFF currently imports `ProfileViewSchema`
     live from `@antiphony/shared`. It must vendor its own profile view *before* this trim,
     or it breaks on upgrade. Coordinate the version bump with that decouple.
4. **Docs/OpenAPI cleanup** (the slice scoped in from the API-docs discussion): the
   generated `/api/reference` stops rendering the moved surface; the API overview stops
   presenting `/users`, `/atproto`, `/resolve` as anything (they're gone, not "legacy").
   Regenerate `openapi.json` + `openapi.surface.json` in the same PR. Also update the stale
   "Public-doc scope" comment in `app.ts` (~line 150) that still lists `/users`, `/resolve`,
   `/atproto`.
5. **Validate cross-repo:** 0.4.0 is not "done" until the Vox Pop BFF consumes the trimmed
   contract and re-implements the moved surface against its own store. B3 and that BFF work
   are coupled, not serial.

### Coupled BFF work (Vox Pop repo)

- Vendor its own `ProfileViewSchema` before the shared 0.4.0 trim (item 3 above).
- Re-implement the moved `/users/*`, `/resolve`, `/atproto` + OAuth-ceremony surface against
  its own store.
- **Serve `/.well-known/did.json` on `did.voxpop.audio`** — a **beta onboarding prerequisite** for
  the app-DID authority model (see [`atproto-authority-model.md`](./atproto-authority-model.md)).
  The doc's `#atproto_pds` endpoint must point at Antiphony; Antiphony validates + snapshots
  it at tenant onboarding.

## Resolved decisions (2026-07-03)

1. **Post-view author shape → `{ id, did? }`.** No handle snapshot on the view — the DID is
   canonical, the handle drifts, and a stale handle on a stable view is a trap. The BFF
   joins presentation (name/avatar/handle) off `authorId`. Core is identity-only end to end.
2. **`dev.antiphony.actor.profile` → keep the schema, no core storage.** The lexicon
   definition stays in `@antiphony/shared` for portability; the BFF is the sole authority
   for profile data. Core never stores or serves it. "All posts by an actor" is the
   `authorId` facet, which is orthogonal to this.
