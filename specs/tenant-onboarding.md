# Tenant onboarding runbook

**Status:** v1, operational. The concrete checklist for connecting a new tenant
(an app / BFF) to an Antiphony deploy. The *why* lives in the design specs this
references — [`service-auth.md`](./service-auth.md) (the auth contract) and
[`atproto-authority-model.md`](./atproto-authority-model.md) (Model B, the
app-DID custody model). This is the *how*.

## What a tenant is, mechanically

A tenant is one `originAppId` present in **two per-tenant registries**, both
keyed by that same id:

| Registry (env var) | Maps | Enforced by |
|---|---|---|
| `ANTIPHONY_APP_TOKENS` | `originAppId → service token` | `middleware/service-auth.ts` — the presented token derives `originAppId`; the credential *is* the tenancy. |
| `ANTIPHONY_APP_DIDS` | `originAppId → app DID` | `lib/app-did.ts` — the DID is the `at://` authority for every record the tenant writes (`at://{appDid}/{collection}/{rkey}`). |

A tenant needs an entry in **both**, with a matching `originAppId`. A token
without a DID pin can authenticate but every post read/write fails closed
(`getAppDid` throws); a DID pin without a token is an unreachable pin. Boot
surfaces either gap as a warning — see [Drift](#drift--re-keying).

## Steps

### 1. Provision the app DID

The app DID must be one whose resolved document carries an `#atproto_pds`
service endpoint pointing at **this Antiphony deploy** (`api.antiphony.dev`) —
that "custody claim is true" check is the point of Model B, and boot rejects any
pin that fails it. A Bluesky account's `did:plc` does **not** qualify: its PDS
endpoint points at Bluesky, not Antiphony.

Three ways to get a qualifying DID (pick per tenant — the method is a per-tenant
choice by construction):

- **Own-domain `did:web`** (the sealed beta decision): register a domain, host
  `/.well-known/did.json` (below). Cleanest; works with the validator as-is; the
  domain can double as the app's Bluesky handle.
- **Hosted dev `did:web` under `antiphony.dev`** (throwaway/staging only, per
  `atproto-authority-model.md`): acceptable for a wipeable, zero-user beta, but
  **must be re-keyed to a real DID before the first kept post** (the GA gate).
- **Antiphony-minted `did:plc`** (the domain-less path): app holds the top
  rotation key. Requires PLC minting + extending the validator to resolve
  `did:plc` (today it is `did:web`-only).

### 2. Host the DID document (`did:web`)

At `https://{domain}/.well-known/did.json` (bare host) or
`https://{host}/{path}/did.json` (hierarchical):

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:{domain}",
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://api.antiphony.dev"
    }
  ]
}
```

The validator requires `id` to equal the pinned DID and an `#atproto_pds`
endpoint whose host matches `ANTIPHONY_PDS_HOST`. A signing `verificationMethod`
(for repo-level attestation) is **not** required yet — the unsigned-repo gap is
deferred in `atproto-authority-model.md`.

### 3. Generate a service token

A random secret **≥32 chars** (shorter tokens are dropped fail-closed). The
tenant keeps it and presents it as `Authorization: Bearer …`. An `originAppId`
MAY carry two tokens simultaneously (rotation window).

### 4. Set the Antiphony deploy env

```
ANTIPHONY_PDS_HOST=api.antiphony.dev
ANTIPHONY_APP_DIDS=bardcast:did:web:{bardcast-domain},voxpop:did:web:{voxpop-domain}
ANTIPHONY_APP_TOKENS=bardcast:{token-a},voxpop:{token-b}
```

`ANTIPHONY_PDS_HOST` is what turns the custody host-match check on — while it is
unset, boot logs a warning and only checks that *an* `#atproto_pds` endpoint
exists, not that it points at us.

### 5. Boot and verify

Boot is fail-closed (`index.ts` → `validateAllPins`): the process refuses to
serve if any pin fails to resolve or its PDS host doesn't match. On a clean boot
you'll see `validated + snapshotted app-DID pins` with both tenants, and **no**
drift warnings from `checkTenantRegistryDrift`.

## Drift & re-keying

Two distinct "drift" concerns:

1. **Registry drift** (implemented): the token and DID registries disagree.
   `checkTenantRegistryDrift` warns at boot — a fast misconfiguration catch.
2. **DID-document drift** (deferred): a `did:web` document changing after
   onboarding is indistinguishable from domain hijack, and is the fragility
   mitigation you get before `did:plc` (`atproto-authority-model.md`). Detecting
   it needs a *persisted* baseline to diff against across boots. Deferred to the
   **GA gate** (first kept post) — during beta the corpus is wipeable and there
   are no live users, so the fragility it mitigates is not yet live.

Because the app DID is sealed into reply StrongRef CIDs at *write* time, treat
any DID change as a re-keying event that invalidates existing thread references
— safe to do freely while the beta corpus is still wipeable, never silently
after.
