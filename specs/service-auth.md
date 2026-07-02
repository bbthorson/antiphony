# Antiphony service-to-service auth

**Status:** v1, implemented. This is the contract connecting services (BFFs)
build against — e.g. the Vox Pop BFF's Antiphony client ("F1" in that repo's
forward plan).

## Model

Antiphony is a headless service. Its callers are **applications** (a BFF, a
worker), not end users. An application authenticates with a service token and
**asserts** which of its users is acting; Antiphony trusts that assertion
within the app's own tenancy. End-user token verification stays in the calling
app — Antiphony never sees a product's session machinery.

Why not forward the end user's Firebase ID token: verifying it would couple
Antiphony to the caller's Firebase project (the exact coupling this service
exists to remove) and would exclude callers that don't use Firebase Auth.

## The contract

### Request headers

| Header | Required | Meaning |
| :--- | :--- | :--- |
| `Authorization: Bearer <service-token>` | yes | The app's service token. Identifies the app; resolves the tenancy key (`originAppId`). |
| `X-Antiphony-Acting-Actor: <actorId>` | on writes / viewer-scoped reads | The app's stable id for the end user performing the action. Becomes `authorId` on created posts and the viewer for reply gating / `viewer` state. |
| `X-Antiphony-Acting-Actor-Did: <did>` | no | The actor's AT Protocol DID, if the app has verified one (via its own OAuth ceremony). Stamped as `authorDid` on created posts. Antiphony trusts the assertion within the app's tenancy. |

Anonymous reads: send the service token with no acting-actor header — the
request is tenancy-scoped but viewer-less (public projection, `canReply: false`).

### Tenancy resolution

`originAppId` is **derived from the credential**, never from the request body
or an env default. A request authenticated as app `vox-pop` can only read and
write `vox-pop`-tenancy records and blobs. The `ANTIPHONY_ORIGIN_APP_ID` env
var remains only as the fallback for the legacy end-user mode below.

### Error semantics

| Condition | Response |
| :--- | :--- |
| Unknown/malformed bearer token | `401` `{ success:false, error:{ message } }` (falls through to end-user token verification first — see below) |
| Service token on a `requireAuth` route with no `X-Antiphony-Acting-Actor` | `401`, message names the missing header |
| Service token shorter than 32 chars in config | entry refused at startup (fail-closed for that app), logged |

## Configuration

`ANTIPHONY_APP_TOKENS` — comma-separated `appId:token` pairs:

```
ANTIPHONY_APP_TOKENS="vox-pop:<64-char-random>,bardcast:<64-char-random>"
```

- Tokens must be ≥32 chars (generate with `openssl rand -hex 32`); shorter
  entries are ignored with an error log — fail-closed, never fail-open.
- Comparison is constant-time.
- Source from Secret Manager in production (`apphosting.yaml`), `.env` locally.
- Rotation: add the new token alongside the old (an app id MAY appear twice
  during rotation), flip the caller, remove the old entry.

This is deliberately env-level for v1 (single-digit app count). A registry
collection with hashed keys + self-serve issuance is the planned upgrade path;
the middleware is the swap point.

## Resolution order (implementation)

For a bearer token on `/api/v1/posts*` and `/api/v1/audio*`:

1. **Service-token match** (constant-time, against `ANTIPHONY_APP_TOKENS`):
   sets `originAppId` from the matched app, `viewerUid` from
   `X-Antiphony-Acting-Actor` (or `null`), `actingActorDid` from its header.
2. **Fallback — end-user mode**: the token is verified as a Firebase ID
   token / session cookie (the pre-existing path). `originAppId` falls back to
   `ANTIPHONY_ORIGIN_APP_ID`. This keeps the hosted reference app and local
   emulator flow working (a browser demo can't hold a service secret) and is
   the compatibility path for existing callers. It is per-deploy behavior, not
   part of the service contract.

Service tokens are long random strings that can never parse as Firebase JWTs,
so trying the service match first is safe and adds no verification cost.

## Non-goals (v1)

- Per-actor authorization inside a tenancy (the app is trusted for its users).
- DID verification (the app performed the OAuth ceremony; Antiphony records
  the assertion — see the actor-registration work in phase B3).
- Request signing / mTLS / GCP OIDC — possible hardening later; the
  middleware is the single swap point.
