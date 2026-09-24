# `did:plc` minting and multi-DID tenancy

**Status:** design, 2026-09-24. Phase 1 (the validator accepts `did:plc`) is
implemented alongside this spec; everything from Phase 2 on is proposal.
Companion to [`atproto-authority-model.md`](./atproto-authority-model.md) (why
the authority sits where it does) and
[`tenant-onboarding.md`](./tenant-onboarding.md) (today's runbook). Neither is
changed here.

## Decisions this builds on

Settled by the project owner, 2026-09-24. This spec designs around them; it
does not reopen them.

1. **Adopt atproto spaces now.** A space's authority is always a tenant's DID or
   an org's DID. **Never Antiphony's.** An Antiphony-held authority would invert
   the exit-sovereignty argument the whole authority model rests on.
2. **Posts published under an org stay with the org.** An org's posts are
   written under the org's DID, not under the member who published them.
3. **The tenant owns audience replies and holds the phone↔user-id layer.** For
   Vox Pop that means SMS repliers are the tenant's to map. Antiphony never
   stores phone numbers and does not mint for anonymous repliers on its own
   initiative.
4. **Minted by default, own-your-DID as a paid upgrade.** Accounts get an
   Antiphony-minted `did:plc`. Owning it is an upgrade that also unlocks
   premium processing (denoise, …).

Two defaults picked here where the decisions leave a fork:

- **The upgrade claims the DID already minted. It never switches to a new
  one.** Reply StrongRefs seal every parent's URI authority into the reply's
  CID at write time, so moving an author to a different DID orphans every sealed
  reference to them. Claiming is a PLC key handover plus a custom handle; the
  DID string does not change, so nothing sealed breaks.
- **Bringing an existing DID is supported at signup only.** Once records have
  been written under a minted DID, that DID is the identity. "I have a Bluesky
  account now, use that instead" is a switch, and switches are the thing the
  StrongRef seal forbids.

## The problem

Today a tenant maps to **exactly one** DID:

- `ANTIPHONY_APP_DIDS` is `originAppId → did`, one entry per tenant
  (`apps/core-api/src/lib/app-did.ts`, `parseAppDids`).
- `getAppDid(originAppId)` is the only authority any write resolves.
- The validator is `did:web`-only and fails closed on anything else, as
  disproof.

The decisions above need one tenant to write under many DIDs: its own, each
org's, and each minted user's. Four things have to change, in this order:

1. The validator must resolve `did:plc`. (**Phase 1, this change.**)
2. Custody must be proven and cached **per DID**, not per tenant.
3. A tenant→DIDs registry must replace the one-DID env var, and must say which
   tenant may write under which DID.
4. Antiphony must be able to mint a `did:plc` without ever holding the key
   that is the holder's leverage against it, and hand that key over on upgrade.

## 1. Validating `did:plc` (Phase 1, implemented)

`validateAppDid` now dispatches on method. `did:web` is unchanged. `did:plc`:

- **Syntax first.** `did:plc:` plus 24 base32 characters (`[a-z2-7]`). Anything
  else is malformed, so disproof, before any fetch. This also stops a crafted
  identifier from steering the request path.
- **Resolve** with `GET {plcDirectory}/{did}`. The default is
  `https://plc.directory`, and it can be overridden per call so tests and a
  future self-hosted mirror don't need a code change.
- **Classify the answer the same way as `did:web`, with the directory's own
  semantics:**

  | Directory answer | Meaning | Kind |
  |---|---|---|
  | 200 + a document | resolved | continue to the custody checks |
  | 404 | the directory has no such DID | **disproof** |
  | 410 | the DID is tombstoned (deactivated by its rotation keys) | **disproof** |
  | anything else, a timeout, a network error, a body that isn't JSON | the directory didn't answer | **unreachable** |

  An outage at `plc.directory` must be `unreachable`, which serves the
  last-known-good within the staleness bound. Treating it as disproof would
  turn a third party's outage into a failed deploy and a 503 for every
  `did:plc` tenant.
- **Custody checks are the same as for `did:web`, and method-blind:** the
  document's `id` must equal the pin, and it must name a custody endpoint
  (`#atproto_space_host`, else legacy `#atproto_pds`) whose host is this
  deploy. PLC renders its service map as `#atproto_space_host`-style fragment
  ids, which `custodyService` already matches by suffix.
- **Unsupported methods** (`did:key`, …) fail as `unsupported-did-method`,
  disproof. This replaces the old `not-did-web` reason.

No PLC library is added for this phase. Resolution is one GET and the checks
are the existing ones. Minting (§4) is where a PLC library earns its place.

**Related to #117 (DID drift).** A `did:web` document change can't be told
apart from a domain hijack. A PLC DID has a signed, append-only operation log
(`GET {plcDirectory}/{did}/log/audit`), so a legitimate rotation can be told
apart from an attack by checking which key signed it. Phase 2's per-DID cache
should store the log head (the CID of the latest operation) next to the
snapshot. Drift then becomes "the head moved", and each new operation can be
checked against the expected signer.

## 2. Per-DID custody (Phase 2)

The validated snapshot is keyed by `originAppId` today. Key it by **DID**:

```
ValidatedDid { did, custody, document, validatedAt, retryNotBefore?, plcHead? }
```

A tenant then holds a *set* of validated DIDs. The freshness, staleness and
404-grace rules in `ensureTenantPin` carry over per DID unchanged. They were
never about tenants; they are about how long a proof about one DID document can
be trusted.

What changes is scale. A tenant has one app DID but can have thousands of user
DIDs, so "revalidate everything hourly" (`revalidateAllPins`) stops being
viable as written:

- **At registration** (mint, claim, bring-your-own): validate synchronously and
  refuse the registration on failure. This is the onboarding gate.
- **On write:** `ensureDid(did)` runs where `ensureTenantPin` runs today, with
  the same three layers (isolate, KV, resolve). A DID that nobody writes under
  costs nothing.
- **Cron:** sweep in bounded batches, oldest `validatedAt` first. For DIDs that
  Antiphony minted and whose top key hasn't been handed over, one audit-log
  read per DID is enough to spot a change we didn't make.

`getAppDid` stays synchronous and keeps its name for the tenant's own DID. A
new synchronous `getWritableDid(originAppId, did)` serves the author/authority
check for every other DID, from the same snapshot.

## 3. The tenant→DIDs registry (Phase 2)

An env var can't hold a user base, and onboarding shouldn't need a
`wrangler secret put`. This is the swap point `app-did.ts` already names ("a
tenant-registry collection is the eventual upgrade path"). Proposed table:

```sql
create table tenant_dids (
  did             text primary key,          -- one DID belongs to at most one tenant
  origin_app_id   text not null,
  role            text not null,             -- 'tenant' | 'org' | 'user'
  subject_ref     text,                      -- the tenant's own id for the org/user; opaque to us
  provenance      text not null,             -- 'minted' | 'brought'
  top_key_holder  text not null,             -- 'tenant' | 'subject' (see §4)
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz                -- set when the subject took the top key
);
create unique index tenant_dids_one_tenant_did on tenant_dids (origin_app_id) where role = 'tenant';
```

- **`did` is the primary key on purpose.** It is what stops tenant A from
  registering, and then writing as, a DID that tenant B already registered.
  Writing under a DID requires a row that joins it to the caller's
  `originAppId`, plus a live custody proof for that DID.
- **`subject_ref` is opaque.** For Vox Pop it's the BFF's user or org id. The
  phone↔user mapping stays in the tenant (decision 3); Antiphony only ever sees
  the id.
- `ANTIPHONY_APP_DIDS` becomes a bootstrap that seeds `role = 'tenant'` rows,
  and is retired once the table is authoritative.

### Which DID a write goes under

The space URI is
`at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
The rules, from the decisions:

| Record | Space authority | `{authorDid}` |
|---|---|---|
| Tenant-published post | tenant DID | tenant DID, or the publishing user's DID |
| **Org-published post** | **org DID** | the publishing member's DID, or the org DID |
| Audience reply (e.g. an SMS replier) | the space it replies into | **tenant DID** (the tenant owns replies, decision 3) |
| User post outside any org | tenant DID | user's DID |

"Posts under the org stay with the org" puts the org DID in the **authority**
position, so an org that leaves a tenant, or a member who leaves an org,
doesn't take the org's posts with them.

This departs from the authority-model spec's note that orgs are an `skey`
under the tenant, which was written to avoid a per-org **hosted `did:web`**.
With a minted `did:plc` the objection that note was answering goes away, and
putting the org DID in the authority slot is the only way the org's posts can
outlive the org's relationship with the tenant. That spec is being edited
elsewhere, so reconciling the two is left to it.

Whether the author segment carries a user's DID or the tenant's is the
**reassignment rule** from the authority recommendation. A user DID in the URI
is sealed; the tenant's DID plus an `authorId` facet stays reassignable. With
claim-don't-switch (above), a minted user DID never needs reassigning, so
putting it in the URI is safe from the moment it's minted.

## 4. Minting (Phase 3)

The requirement: **the holder's key is the highest-priority rotation key, and
Antiphony holds only a lower-priority operational key.** PLC orders
`rotationKeys` by priority. A higher-priority key can nullify any operation
signed by a lower one within 72 hours. So whoever holds `rotationKeys[0]` can
always undo what Antiphony did, and can remove Antiphony's key entirely. That
is the exit.

Who holds `rotationKeys[0]` at mint time:

| Role | Top rotation key at mint | Why |
|---|---|---|
| tenant | the tenant | It is the tenant's authority. Antiphony must never hold it. |
| org | the tenant, on the org's behalf | Most orgs can't manage keys. It moves to the org on claim. |
| user | the tenant, on the user's behalf | Same, and the tenant already owns the account relationship (decision 3). It moves to the user on claim. |

Antiphony never holds the top key for any role. It is the operator, not the
custodian.

### Genesis flow

1. The tenant (its BFF) calls `POST /api/v1/dids` with `{ role, subjectRef,
   handle?, rotationKey }`, where `rotationKey` is the **public** half of a key
   the tenant generated and keeps. The private half never crosses the wire.
2. Antiphony builds the unsigned genesis operation:
   - `rotationKeys: [tenantKey, antiphonyOperationalKey]`
   - `verificationMethods.atproto`: Antiphony's signing key for this DID (see
     the open questions)
   - `services.atproto_space_host`: this deploy's endpoint
   - `alsoKnownAs`: the handle, if any
3. Antiphony returns the operation's canonical bytes. The tenant signs them with
   its rotation key and returns the signature. Antiphony checks that the
   signature verifies against `rotationKeys[0]`, submits the signed operation to
   PLC, and gets back the DID (derived from the signed genesis op).
4. Antiphony re-resolves the DID through the §1 validator, and only then writes
   the `tenant_dids` row. A mint whose resulting document doesn't prove custody
   is never registered.

Antiphony's operational key signs routine updates later, such as a
service-endpoint move. Because the tenant's key outranks it, a bad update can
be reversed without Antiphony's cooperation.

A **sovereignty check** joins the validator here. For `provenance = 'minted'`,
read `GET {plcDirectory}/{did}/data` and refuse if Antiphony's operational key
is at index 0. That is the one configuration the design exists to prevent, and
it is cheap to assert on every revalidation.

## 5. The paid upgrade: owning your DID (Phase 4)

"Own your DID" is a **claim**:

1. The subject generates a rotation key (in the tenant's client, on their
   device).
2. The current top-key holder (the tenant) signs a PLC operation that puts the
   subject's key at `rotationKeys[0]`. It keeps Antiphony's operational key
   below it and, by default, drops the tenant's key. The tenant could keep its
   key at index 1 as a recovery path, but that is a product call. The default
   is full handover.
3. Optionally, a custom handle: `alsoKnownAs` updated in the same operation,
   plus the handle's own DNS or `.well-known` proof.
4. `tenant_dids.top_key_holder = 'subject'`, `claimed_at = now()`.

The DID string is unchanged, so every URI and StrongRef stays valid.

**Where the paywall sits.** Entitlement is the tenant's concern: Vox Pop already
has tiers and feature gates. Antiphony stays policy-free about plans. The claim
endpoint and denoise are ordinary API capabilities, and the tenant decides who
may trigger them. The alternative, Antiphony tracking a per-DID entitlement, is
only worth building if Antiphony ever bills end users directly. Nothing in the
current decisions asks for that.

**Bring your own DID (signup only).** Accepted when its document names this
deploy as `#atproto_space_host`, which is the same §1 validation. Registered
with `provenance = 'brought'` and `top_key_holder = 'subject'`. The sovereignty
check doesn't apply, because Antiphony holds no key in it.

## Phasing

| Phase | Ships | Depends on |
|---|---|---|
| 1 | Validator resolves `did:plc` (§1) | nothing. **Done in this change.** |
| 2 | Per-DID snapshot + `tenant_dids` table + `getWritableDid` (§2, §3) | a migration. The spaces URI migration uses it. |
| 3 | `POST /api/v1/dids` genesis flow + sovereignty check (§4) | a PLC op library; Antiphony operational key as a secret |
| 4 | Claim / handle upgrade (§5) | Phase 3 |

The spaces URI migration and Phase 2 depend on each other: space URIs need the
registry to know which DID a write may go under. Both have to land before the
corpus stops being wipeable.

## Open questions

- **The `atproto` signing key.** Antiphony writes the records, so today it
  would hold every minted DID's signing key. That is honest under the existing
  "unsigned-repo gap" (a StrongRef CID verifies content, not custody), but on
  claim the subject may want their own signing key. That only matters once
  Antiphony signs repo commits, which it doesn't yet.
- **`plc.directory` as a dependency.** Every `did:plc` tenant's liveness now
  depends on a single Bluesky-run service. The `unreachable` classification
  keeps an outage from becoming ours within the staleness bound. The tenant
  terms should still name the dependency rather than hide it.
- **Bulk minting.** `plc.directory` rate-limits writes. Minting a DID for every
  existing account in one go needs a queue. Minting lazily at an account's
  first kept write avoids the problem.
- **Handle namespace.** Minted DIDs need a default handle, either under the
  tenant's domain or under an Antiphony subdomain. A handle under Antiphony's
  domain is the same permanence trap as hosted `did:web`, just at the handle
  layer. Default to the tenant's domain.
