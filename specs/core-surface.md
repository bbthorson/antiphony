# Core API Surface — the headless boundary

**Status:** Decided 2026-07-05. Supersedes the inherited `vox-pop-core-api`
surface. Implementation follows in a separate PR (breaking → version bump, see
[`api-versioning.md`](./api-versioning.md)).

## Decision

Antiphony's public API surface is **posts + audio only**. Author identity is
carried on post views as **opaque references** (`authorId`, and `authorDid` when
the caller asserts one) — never as a hydrated profile. The caller BFF, which
owns user metadata, hydrates authors from its own store.

The inherited **user / handle / actor-identity cluster is removed** from the
public contract:

| Group | Endpoints | Verdict |
|---|---|---|
| **Posts** | list-mine, create, `GET /{id}`, `/{id}/replies` | ✅ **Keep** — the core |
| **Audio** | `GET /audio` (sign URL), `POST /audio/upload` | ✅ **Keep** — audio hygiene/storage |
| **Users** | list profiles, list handles, `me` (get/patch/delete), claim/check handle, `GET /{handle}`, `/{handle}/profile` | ❌ **Remove** — account/profile management is the BFF's job |
| **Actors** | `register`, `GET /{actorId}` | ❌ **Remove** — DID is asserted per-request, not registered |
| **Resolve** | `GET /resolve/{handle}` | ❌ **Remove** — handle directory is BFF-owned |
| **atproto** | `disconnect` | ❌ **Remove** — per-user identity mgmt is BFF-owned |

## Why

Antiphony is a **headless post-storage + audio-hygiene service**; user metadata
lives in the caller BFF (see [`core-bff-boundary.md`](./core-bff-boundary.md)).
The `Users`/`Actors`/
`Resolve`/`atproto` surface is a wholesale inheritance from the
`vox-pop-core-api` fork — a full app backend. A post store has no business
owning handles, profiles, account lifecycle (`POST /users/me/delete`), or a
handle directory. Keeping it recreates the exact BFF↔core coupling the
decoupling exists to remove, and it forces every tenant to push private-ish
identity into a service that is supposed to hold none.

## The author model

`AudioPostView.author` shrinks from a hydrated `ProfileViewBasic` to opaque
references:

```jsonc
// before (hydrated — removed)
"author": { "did": "…", "handle": "…", "displayName": "…", "avatar": "…" }

// after (opaque — Path 1)
"authorId":  "sLhaGagvW5NEw6Vc4BMtdyuBlTb2",   // the app's own user id (attribution facet)
"authorDid": "did:web:voxpop.audio"            // present only when the caller asserted one
```

- Antiphony returns the ids it was given at write time (`authorId` = the acting
  actor; `authorDid` = the app-asserted DID). It performs **no profile lookup**.
- The **BFF hydrates** display identity (handle, name, avatar) from its own store
  by joining on `authorId` — data it already owns. For a list of posts this is a
  single cheap batch lookup on the side that holds the data.
- A post whose author has no public identity (e.g. a phone-only replier) simply
  has no BFF-side profile to hydrate — it renders author-less, which is correct.

This makes Antiphony hold **zero** user data. Note the `at://` **authority** is
unaffected: it is the tenant **app DID** (Model B), and `authorDid` remains an
attribution facet outside the record CID — exactly as
[`atproto-authority-model.md`](./atproto-authority-model.md) specifies.

## What implementation removes

- **Routes:** the `Users` (9), `Actors` (2), `Resolve` (1), and `atproto/disconnect`
  (1) route modules and their mounts.
- **Hydration:** `getAuthorsByIds` and the `author` projection in the post-view
  builder; the `users` collection reads for view assembly.
- **Storage:** the `users` collection / public-profile projection and the handle
  registry become dead — including the 2 profiles seeded during the voxpop
  migration (author hydration moves to the BFF; the phone-only replier was
  already profile-less, so it is unchanged).
- **Auth path:** the Firebase ID-token / session `sessionVerifier` fallback in
  `middleware/auth.ts` and the `viewerSession` context var (see *Auth:
  service-token only* below). `service-auth.md` gets a follow-up amendment noting
  service-token is now the sole credential.
- **OpenAPI narrative** (fork-stale, fix in the same PR):
  - `OPENAPI_INFO.description` (`lib/openapi-info.ts`) leads with Firebase ID
    tokens and references a `POST /api/v1/auth/session` route that **does not
    exist in this surface**. Rewrite it to describe **service-token +
    `X-Antiphony-Acting-Actor`** as the *only* auth — drop the Firebase / session
    language entirely.
  - `OPENAPI_TAGS`: drop `Users`, `Actors`, and the identity-linking `Auth` tag.
- **Docs:** `lexicons/overview.md` still describes a pre-Model-B "actor-id URI
  authority" fallback that was already removed — correct it to the app-DID
  authority (independent of this trim, but land it here).

## Auth: service-token only

**Decided 2026-07-05.** The service token is the **only** accepted credential.
The inherited Firebase ID-token / session-cookie fallback (`sessionVerifier`, the
second path in `middleware/auth.ts`) is **removed**.

Rationale: Antiphony is headless — every caller is an *application* (a BFF), so
every request already carries a service token. Verifying end-user Firebase tokens
recouples the service to a specific Firebase project — the exact coupling the
decoupling exists to remove — and is a `vox-pop-core-api` fork leftover from when
this code *was* the app backend. The reference app is itself just another
caller: it presents a service token like any BFF; it does not need Antiphony to
verify end-user identity.

This removes, from `middleware/auth.ts`:

- the `sessionVerifier` end-user path in both `optionalAuth` and `requireAuth`,
- the `viewerSession` context variable (the decoded Firebase session), and
- Antiphony's dependency on Firebase **Auth** token verification (Firestore /
  Storage admin usage is unaffected).

After this, auth is: **service token → app** (tenancy + optional acting-actor);
no service token → anonymous on `optionalAuth`, `401` on `requireAuth`.

**Sub-question — tokenless public reads.** With the Firebase path gone, the only
remaining tokenless caller is an anonymous public read (`optionalAuth`, no token),
which falls back to the default tenancy (`ANTIPHONY_ORIGIN_APP_ID`). Recommended
follow-up: require the service token on all data routes so the token always
establishes *which* tenant is being read, and drop the ambiguous default-tenant
fallback. Flagged, not decided here — the Firebase removal stands on its own.

## Rollout

No deprecation window is needed. The only wired tenant (voxpop) is **not** yet
calling these routes (its BFF still reads the legacy `vox-pop-core-api` store),
and there are no other consumers. So:

1. Land the BFF's author-hydration change (join on `authorId`) — or confirm the
   reference app is the only reader of `author`.
2. Remove the routes + hydration + narrative fixes in one PR.
3. Breaking change → bump the contract version per
   [`api-versioning.md`](./api-versioning.md) (`0.1.0` → `0.2.0`).
