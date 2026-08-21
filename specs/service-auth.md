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

`originAppId` is **derived from the credential**, never from the request body.
A request authenticated as app `voxpop` can only read and write
`voxpop`-tenancy records and blobs. The `ANTIPHONY_ORIGIN_APP_ID` env var is
the tenancy only for an anonymous read (`optionalAuth` with no service token) —
a self-hoster's single-tenant default.

### Error semantics

| Condition | Response |
| :--- | :--- |
| Unknown/malformed bearer token on a `requireAuth` route | `401` `{ success:false, error:{ message: 'Invalid service token' } }` |
| Unknown/malformed bearer token on an `optionalAuth` route | treated as anonymous (no error) — a stale credential must not block a public read |
| Service token on a `requireAuth` route with no `X-Antiphony-Acting-Actor` | `401`, message names the missing header |
| Service token shorter than 32 chars in config | entry refused at startup (fail-closed for that app), logged |

## Configuration

`ANTIPHONY_APP_TOKENS` — comma-separated `appId:token` pairs:

```
ANTIPHONY_APP_TOKENS="voxpop:<64-char-random>,bardcast:<64-char-random>"
```

- Tokens must be ≥32 chars (generate with `openssl rand -hex 32`); shorter
  entries are ignored with an error log — fail-closed, never fail-open.
- Comparison is constant-time.
- Source from Secret Manager in production (mounted by `.github/workflows/deploy.yml`), `.env` locally.
- Rotation: add the new token alongside the old (an app id MAY appear twice
  during rotation), flip the caller, remove the old entry.

This is deliberately env-level for v1 (single-digit app count). A registry
collection with hashed keys + self-serve issuance is the planned upgrade path;
the middleware is the swap point.

## Resolution (implementation)

The **service token is the only accepted credential** (see
[`core-surface.md`](./core-surface.md), "Auth: service-token only"). For a
bearer token on `/api/v1/posts*` and `/api/v1/audio*`:

- **Service-token match** (constant-time, against `ANTIPHONY_APP_TOKENS`):
  sets `originAppId` from the matched app, `viewerUid` from
  `X-Antiphony-Acting-Actor` (or `null`), `actingActorDid` from its header.
- **No match**: `requireAuth` returns `401`; `optionalAuth` proceeds as an
  anonymous read (tenancy = `ANTIPHONY_ORIGIN_APP_ID`).

The inherited Firebase ID-token / session-cookie fallback was removed:
Antiphony is headless, so every caller is an application that presents a
service token — verifying end-user tokens would recouple the service to a
specific Firebase project. The reference app is itself just another caller.

## Signed service auth (`X-Antiphony-Service-Auth`) — observation only

**Status:** verifier implemented, **not enforcing**. The `Authorization` bearer
token above is still the only credential. This section describes a header that
rides alongside it and currently changes nothing about any response.

Vox Pop's app DID (`did:web:did.voxpop.audio`) publishes a P-256 `Multikey`
`verificationMethod`, and its BFF signs a short-lived ES256 JWT into
`X-Antiphony-Service-Auth` on every upstream call (issue #116; the signer is
`apps/vox-pop-api/src/lib/antiphony-service-auth.ts` in that repo).

### The token

| | |
| :--- | :--- |
| `alg` | `ES256`, and only `ES256`. No agility — `none` has nowhere to enter. |
| `kid` | Fragment naming the `verificationMethod` (`#atproto`). Selected, never trial-verified. |
| `iss` | The tenant's app DID. Resolved to `originAppId` through `ANTIPHONY_APP_DIDS`. |
| `aud` | Antiphony's own DID — an identity, never the origin URL. See `serviceDid()`. |
| `iat` / `exp` | 60s lifetime; 60s clock skew tolerated; >300s span refused. |
| `lxm` | NSID. **XRPC calls only.** |
| `op` | `"<METHOD> <path>"`. **REST calls only.** |

`lxm` and `op` are mutually exclusive and exactly one must be present — a token
carrying both is malformed and refused. REST paths deliberately stay out of
`lxm` so a spec-aware reader cannot parse `"POST /api/v1/posts"` as a lexicon
method. Whichever is present is matched against the operation actually being
served, which is what makes a captured token useless elsewhere and what lets a
60s lifetime stand in for a replay cache.

> ⚠️ **This is atproto-shaped but is NOT AT Protocol service auth.** It is an
> agreement between two services we operate. Do not implement or "correct" it
> from that spec — `op` has no meaning there, and Antiphony is not a PDS (#115).

### Why the pin registry is the issuer registry

`iss` resolves through `ANTIPHONY_APP_DIDS` — the existing pin — rather than a
second list that could disagree with it. This preserves the invariant above that
`originAppId` comes from the credential and never from the request, and tightens
it: today that credential is a shared secret held in full by both sides, and
under this scheme it is a signature attributable to a key only the tenant holds.

Verification does no request-path network I/O. `ensureTenantPin` has already
snapshotted the DID document, so the key is a field read on something in memory.

### Two limits, stated rather than buried

- **The keystore inherits the pin cache's staleness.** The document is the one
  last resolved — 1h freshness, 24h stale-serve while the `did:web` host is
  unreachable. Defensible for an observation. If this ever becomes the *only*
  credential, that window is the blast radius of a tenant's DID host going down,
  and it must be revisited **before** the flip, not after.
- **Document drift is not detected (#117).** Whoever controls the `did:web` host
  can add a `verificationMethod` and mint tokens this verifier accepts. That is
  the strongest single reason enforcement waits.

### Rollout

1. **Now — observe.** `observeSignedServiceAuth` logs whether the token verifies
   and whether it names the same tenant the bearer token did. A verified token
   naming a *different* tenant logs at `error` and is the one result that should
   stop the rollout. Nothing affects the response; the tests in
   `signed-service-auth-observation.test.ts` assert exactly that.
2. **Then — enforce**, once the agreement rate is boring, and once #117 is
   closed.
3. **Then — retire `ANTIPHONY_APP_TOKENS`**, on both sides. That removes a
   static secret that today exists in full on both sides, so rotation is a
   two-service dance and either side's compromise is the other's. After the flip
   Antiphony holds only a public key.

### Configuration

`ANTIPHONY_SERVICE_DID` — Antiphony's own DID, the only accepted `aud`. Defaults
to `did:web:<host of ANTIPHONY_PUBLIC_BASE_URL>`, which is derived the same way
Vox Pop derives its copy, so the two cannot drift by editing one config. Note
that this identifier does not currently resolve — we publish no DID document —
which #115 should settle.

## Non-goals (v1)

- Per-actor authorization inside a tenancy (the app is trusted for its users).
- DID verification (the app performed the OAuth ceremony; Antiphony records
  the asserted `authorDid` on the post, outside the record CID).
- mTLS / GCP OIDC. Request signing is no longer on this list — see the signed
  service auth section above — but it is not yet a credential either.
