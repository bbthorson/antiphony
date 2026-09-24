# AT-Proto authority model — app-as-repo-owner (Model B)

**Status:** decided 2026-07-03. Foundational data-model decision that
[`core-bff-boundary.md`](./core-bff-boundary.md) (the seam) and B3 depend on.
Informed by a Fable design review of `buildPostUri`/`canonicalPostRecord` and the
`ActorIdentityRecord` design.

**Updated 2026-09-24:** the decisions for making Antiphony publicly available —
spaces adopted, authority chosen by context, minted DIDs by default, attribution
owned by the app — are in
[§ Update 2026-09-24](#update-2026-09-24--decisions-for-public-availability).
Where they revise an earlier paragraph, that paragraph says so in place.

## Decision

The calling **application is the repo owner**. Each tenant (`originAppId`) has its own
DID (`did:web` on the app's domain); that **app DID is the `at://` authority** for every
record the tenant writes. The end-user's DID is demoted to **authorship attribution** — an
out-of-CID facet — never the authority.

`at://{appDid}/{collection}/{rkey}` — always a real DID, no fallback, regardless of whether
the acting end-user has ever linked an identity.

## Why (the two decisive, code-grounded reasons)

1. **StrongRef sealing makes Model A's URIs unrepairable.** `reply.root`/`reply.parent`
   StrongRefs are in the canonical projection (`audio-posts.ts:131`), so a parent's
   authority string is hashed into every reply's immutable CID. Under the current model
   (`authorDid ?? authorId`, `audio-posts.ts:75`), when a parent author links a DID later,
   `buildPostUri` emits a *different* authority for the same post — old replies reference
   `at://{authorId}/…`, new ones `at://{did}/…`, forked permanently. The docstring promise
   that "federation later swaps this for the real repo uri without changing the call sites"
   (`audio-posts.ts:68`) is therefore false. **Corollary:** our "no author identity in the
   CID" claim is *already false for replies*. Under B the authority is the app DID, which
   never changes → the whole failure class disappears.
2. **The current DID authority is a dangling/invalid reference even on the happy path.** A
   user's `did:plc` resolves to *their* PDS (e.g. Bluesky), not Antiphony; `at://{userDid}/…`
   asserts the record lives where it doesn't and can't (one DID = one repo on one PDS). And
   the fallback authority — a Firestore `authorId` — is neither a DID nor a dotted-hostname
   handle, so it's a *syntactically invalid* at-uri any parser may reject. Model B's
   `did:web:app.example` can serve a real `did.json` whose `#atproto_pds` endpoint points at
   Antiphony — the only model where the URI tells the truth.

## The model

- **Authority = custody, not authorship** (the protocol's actual invariant — author DID
  isn't a record field *because* repo location carries it). Custody → app DID in the URI;
  authorship → attribution facet. The two are never conflated.
- **App DID:** one per `originAppId`; the `at://` authority; stable for the tenant's life.
  *Revised 2026-09-24 (D2):* the app DID stays the authority for what the app itself
  owns (audience replies), but an org's posts and a user's own posts are authored under
  *their* DID. The tenant becomes the custodian of several authorities, not one.
- **User DID + `authorId`:** attribution, stamped as facets, **out of the record CID** and
  out of the URI — so they stay mutable and backfillable.
- **Superseded — attribution is owned by the app** (decided 2026-09-24, D5; closes
  [#121](https://github.com/bbthorson/antiphony/issues/121)). This bullet used to say the
  actor↔DID table stays in Antiphony and travels with an export. The table was removed on
  2026-07-05 (see `core-bff-boundary.md`) and this bullet never caught up. As built, and now
  as decided, the calling app holds the mapping from its opaque `authorId` to a person, and
  an exported corpus carries ids only that app can resolve.

## Why keep attribution out of the CID

- **Buys nothing verifiable** — Antiphony never sees user keys; a CID-bound `authorId` looks
  cryptographically attested and isn't.
- **Costs erasure** — a pseudonymous user id baked into content-addressed, possibly-federated
  records is unredactable; a mutable facet can be severed on account deletion.
- **Costs re-homing** — with identity out of the hash, identical content re-published into a
  user's own repo later keeps the *same* record CID (a genuinely nice property for the escape
  hatch below).

## Code consequences (this decision — precede or accompany B3, not gated on it)

- `buildPostUri`: authority becomes the app DID (resolved from `originAppId`); drop the
  `authorDid ?? authorId` fallback; the signature gains the app DID / a tenant→DID lookup.
- Fix the now-false docstring (`audio-posts.ts:65-69`) and any spec language calling the
  DID-or-authorId URI "canonical." **Do this while it's free** — beta, no live Vox Pop users.
- `parsePostId` (`audio-posts.ts:83`): validate the StrongRef authority matches the caller's
  tenant app DID at parse time (defense-in-depth over the tenancy check already in
  `resolveReplyParticipants`). `parsePostId` is a pure last-segment extractor today, so this
  is a **signature change**: either extend it to take the expected app DID / tenant context,
  or add a separate `parseAndValidatePostUri(uri, appDid)` helper and leave `parsePostId`
  pure. Prefer the separate helper — keeps the inverse-of-`buildPostUri` extractor pure and
  makes the authority check an explicit, greppable call.
- rkeys (`newPostId()`): guarantee unique-per-tenant, ideally TID-shaped so ecosystem sort
  tools work.

## App DID method (sub-decision — decided 2026-07-03)

**Vox Pop beta uses an own-domain `did:web` (`did:web:did.voxpop.audio`), behind a
method-agnostic per-tenant pinning layer.**

**Why `did:web`, precisely:** not cost — **exit sovereignty**. `did:web:did.voxpop.audio` is the
only option where the app can leave Antiphony with *zero cooperation from us*: Vox Pop
controls voxpop.audio, so it controls the DID document, so it can repoint the
`#atproto_pds` endpoint at a new host, import the exported corpus, and every `at://` URI
ever minted stays valid — without asking Antiphony. That makes the "the app can take its
corpus and leave" story mechanically true. The fragility (a lapsed domain / rebrand orphans
the identity) is the *price* of that sovereignty — the same tradeoff the protocol makes with
handles — not a separate defect. `did:plc`, by contrast, survives a rebrand not "via key
rotation" but because **the DID string isn't domain-derived at all**; its rotation keys are
the document update/recovery mechanism `did:web` lacks.

**The pinning-layer contract** (this is the concrete infra decision we're making now, and
it's what makes the method a per-tenant choice by construction):

- **Pin the DID as an opaque string per tenant** at onboarding. The tenant registry stores
  it; nothing downstream ever re-derives it from the domain or recomputes it.
- **Validate per-method, then snapshot the resolved DID document.** For `did:web`: fetch
  `/.well-known/did.json` over HTTPS *once* and store what you got — never re-resolve on the
  request path.
- **Require the document's PDS service endpoint to point at Antiphony** at validation time —
  this is the "custody claim is true" check from the Model B rationale.
- **Treat any observed change to the resolved document as an explicit re-keying event** —
  surfaced and acknowledged, never silently absorbed. For `did:web`, document drift is
  indistinguishable from domain hijack, so **drift detection is the fragility mitigation you
  get to have before `did:plc`.**
  **Not implemented** ([#117](https://github.com/bbthorson/antiphony/issues/117)): nothing
  compares a resolved document to an acknowledged baseline today, so this point is a
  requirement, not a guarantee. A `did:plc` authority largely doesn't need it, because PLC's
  signed, append-only operation log tells a legitimate rotation from an attack by inspection.

**The revisit deadline is the first Vox Pop post we commit to keeping** — i.e. the
end-of-beta keep-or-wipe call (effectively GA). `did:web:did.voxpop.audio` is provisional exactly
as long as we're still willing to wipe the beta corpus. It is **not** "second app" (the
method is per-tenant, so tenant #2 chooses `did:plc` independently — no global call is
waiting) and **not** "first export" (the authority is sealed into reply StrongRef CIDs at
*write* time, so permanence already happened long before any export). Write it down as the
GA gate so "we can revisit later" doesn't quietly expire when the first production thread
forms.

**Domain-less future apps:** offer an **Antiphony-minted `did:plc` with the app holding the
highest-priority rotation key** (PLC supports ordered rotation keys, so Antiphony can hold a
lower-priority operational key). Do **not** offer hosted `did:web:antiphony.dev:tenants:{app}`
as a general fallback — it has the *worst* permanence properties of the three: the DID
document lives on Antiphony's domain forever, permanently inverting the exit-sovereignty
story that justifies `did:web` at all (lock-in wearing the exit hatch's syntax). Reserve
hosted `did:web` only for explicitly throwaway tenants (staging, integration tests) where
"orphaned forever" is fine because forever is a sprint.

*Revised 2026-09-24 (D3):* minting is now the **default**, not the domain-less fallback,
and it covers orgs and users as well as tenants. Own-domain `did:web` stays accepted. The
exclusion of hosted `did:web` stands unchanged.

**BFF prerequisite:** Vox Pop serving `/.well-known/did.json` on `did.voxpop.audio` is a **beta
onboarding prerequisite** — it belongs on the coupled BFF work list next to the B3 cross-repo
items in [`core-bff-boundary.md`](./core-bff-boundary.md).

## Update 2026-08-21 — not a PDS, and where atproto spaces fits

Two decisions, both prompted by [#115](https://github.com/bbthorson/antiphony/issues/115)
and by atproto's permissioned-data work ("spaces") reaching alpha on 2026-08.
Model B itself is unchanged; what changes is what the DID document is allowed to
say, and what the destination is if the data plane ever moves onto the protocol.

### Decision 1 — Antiphony is not an AT Protocol PDS, and is not becoming one

`AtprotoPersonalDataServer` promises `com.atproto.repo.*` and
`com.atproto.sync.*` over signed MST commits plus a firehose. Probed against the
live service on 2026-08-20 and again on 2026-08-21, while it was up and serving
its own namespace (`dev.antiphony.audio.getPost` → 401):
`describeServer` 404, `describeRepo` 404, `getLatestCommit` 404, `listRepos` 404.
Consistent with the unsigned-repo gap below — there are no signed commits to
serve, so the sync surface could not be honoured even if the routes existed.

**The claim is false, and the deploy gate required tenants to make it.** That is
the defect: `validate-pins.ts` demanded an `#atproto_pds` entry naming us, so a
tenant could not correct its own document without failing our deploy. The wrong
claim was load-bearing for reasons that had nothing to do with whether it was
accurate.

Becoming a real PDS is not work worth doing to make one sentence true. So:
**not a PDS.** The custody check now accepts `#atproto_space_host` —
atproto's own entry for the host serving a space authority's repos, which
describes what this service is — with `#atproto_pds` still accepted so no tenant
breaks in transit, and `validate-pins.ts` naming the tenants still on it so
"once tenants have migrated" is a condition someone can actually evaluate.

This also settles an objection raised against inventing a bespoke type
(`#antiphony_host`): a vendor-specific entry would be repointable at nothing,
narrowing the exit hatch from "any atproto PDS" to "any host implementing
Antiphony's interface" — a set with one member — and quietly gutting the
exit-sovereignty argument in "App DID method" above. A **standard** entry does
not have that problem. The sovereignty argument survives intact, with
`#atproto_space_host` substituted for `#atproto_pds` as the thing a departing
tenant repoints.

### Decision 2 — spaces is not adopted now; it is the destination if the data plane moves

> **Revised 2026-09-24: adopted** (D1). The second reason below no longer holds:
> Bardcast's semi-private campaigns are gated, non-public audio, which is the product need
> this section was waiting for. The first reason (alpha) is accepted as a risk while the
> corpus can still be wiped.

atproto spaces are per-space permissioned repos with access control at a space
boundary — a space authority DID, a space host, and repo hosts, explicitly not
required to be collocated. **Not adopted**, for two reasons that are about
timing rather than fit:

- **Alpha.** Bluesky's own framing: not for production, breaking changes
  expected, database schemas changing without clean migrations.
- **No product need pulls it yet.** The thing spaces uniquely solve is *gated
  non-public audio* — subscriber-only posts, or shared reply playback. Antiphony
  records carry no visibility dimension at all today, and nothing has asked them
  to.

**It is nonetheless the leading candidate**, because the shape already matches.
A space record is addressed as:

```
at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}
```

The space DID is the **authority**; the author DID is a **path segment**. That
is precisely this document's decision — custody in the authority position,
authorship demoted out of it — arrived at independently by the protocol six
weeks later. It also answers the question deferred below as *both*: per-author
repos, aggregated into an app-scoped space.

Two notes for whoever picks this up:

- **Orgs are not spaces, and if they ever were, they would be `skey`.** A space
  is `(authority, type, skey)`, so a per-org space needs no per-org DID — which
  is what would otherwise sink it, given the hosted-`did:web` permanence
  argument above. The relevant policy is `managing-app`, which defers
  authorization to the application's own state via `checkUserAccess`; adopting
  spaces would **not** require giving up an existing role model.
  *Revised 2026-09-24 (D2):* "posts published under an org stay with the org" is
  decided, and it is met by giving the org its **own DID as the authority**, not an
  `skey` under the tenant. The per-org-DID objection above was the hosted-`did:web`
  permanence problem, which a minted `did:plc` doesn't have. An org still needs no
  space for *visibility*: Vox Pop prompts are public by invariant (vox-pop
  `specs/organizations.md` § 1).
- **The tenant's DID is already the space authority.** `did:web:did.voxpop.audio`
  would be the space DID. Migration inserts a path segment; it does not change
  who the authority is.

### What this does to the URIs written between now and then

Adopting spaces later changes the URI shape, and reply StrongRefs seal the
authority string into every reply's immutable CID at **write** time — the same
mechanism that made Model A's URIs unrepairable and decided this document.

So: **every `at://` URI minted before a spaces migration is provisional exactly
as long as the corpus is still wipeable.** That is the same gate already named
below as the revisit deadline ("the first Vox Pop post we commit to keeping"),
and it is the real deadline for Decision 2 — not a date, and not a beta
milestone. Onboarding beta testers does not close it; *promising to keep their
data* does. If the beta's terms state that the corpus may be wiped, the option
stays open for as long as that remains true.

### The gap that would have to close first

Spaces assumes user-to-host alignment: each author controls their own repo on
their own host, and the URI requires an `{authorDid}`. Vox Pop's users are split:

- **Inbox owners** authenticate with an AT Protocol identity — real DID, own
  PDS. Alignment already satisfied; their repos would not live here at all, and
  Antiphony's role would narrow to audio processing and blob custody.
- **Repliers** are SMS-authenticated with no DID, and the phone↔actor table is
  the BFF's (see the Actors-surface reversal noted under "The model" — the
  actor↔DID vertical was removed from Antiphony on 2026-07-05, so this service
  cannot close the gap on its own).

Mixed identity does not block a space: the **app DID can be the space author**
for records whose human author has no identity, which is Model B preserved
inside a space, alongside real-DID authors who bring their own repos. The
alternative — minting DIDs for SMS repliers — creates a permanent public
identity for someone whose only act was replying to a text, and is a consent
question before it is an architectural one.

## Update 2026-09-24 — decisions for public availability

Decided by Brad in the project thread between 2026-09-22 and 2026-09-24, for the "make
Antiphony publicly available" work. Nothing here is implemented yet. The build work is
tracked in its own threads: `did:plc` minting and multi-authority tenancy, spaces
support, the paid DID upgrade in Vox Pop, and Bardcast's campaign model. **All of it is free to change until the first kept post**, because reply
StrongRefs seal the authority at write time (see "What this does to the URIs" above).

### D1 — Spaces are adopted

Decision 2 above is reversed. The first consumer is Bardcast: each campaign is a
semi-private space, an `skey` under Bardcast's authority, with membership answered by the
`managing-app` policy from Bardcast's own state. There are no nested spaces and no
per-campaign DID. Vox Pop doesn't need spaces for its orgs (D2).

### D2 — Authority is chosen by who should keep the post

Model B's rule, "authority = custody", still holds. What changes is that the tenant can now
hold custody of more than one authority.

| Who posts | `at://` authority | Author | Who keeps it |
| :--- | :--- | :--- | :--- |
| An audience reply (Vox Pop, phone or SMS) | the app's DID | opaque `authorId` facet | the app. The app can leave Antiphony; the replier can't take it. |
| A post published under an org | the org's own DID | the creator | the org, including after the creator leaves. |
| A solo user's own post | the user's DID | the user | the user. Brad's stated lean ("their URI should be their handle, I think") and the reason D3 mints user DIDs; to confirm before it's built. |
| Bardcast campaign content | Bardcast's DID, campaign `skey` | the player's DID segment | the campaign. |
| A Bardcast character (profile, voice) | the player's DID | the player | the player, portable off Bardcast. |

A DID may be an authority only if its document names Antiphony as the custody host. That is
the same custody check tenants pass today, applied per DID. It's why Model B's reason 2
(a user's `did:plc` points at their own PDS, not here) doesn't block user or org
authorities: a DID Antiphony minted names Antiphony from genesis, and a user who brings a
DID must add the `#atproto_space_host` entry themselves.

### D3 — DIDs are minted by default, and owning yours is a paid upgrade

- New tenants, orgs and users get an **Antiphony-minted `did:plc`**, with the owner holding
  the highest-priority rotation key and Antiphony a lower-priority operational key.
  Own-domain `did:web` stays accepted.
- **"Own your DID" is a paid feature, and it's app-tier.** In Vox Pop it also unlocks
  processing such as denoise. Antiphony stays unaware of tiers: the app decides which
  posts to opt into processing, as it does today.
- **The upgrade claims the minted DID. It never switches to a different one.** Claiming
  means handing over the rotation key and attaching a custom handle. Switching would give
  every existing post a new authority and orphan every reply that points at it. Bringing an
  existing DID is therefore supported at signup only.

### D4 — A person's DID is reassignable only while it's a facet

`authorId` and `authorDid` are kept out of the record CID (`canonicalPostRecord`,
`packages/core/services/audio-posts.ts`), so filling in or changing them later is a plain
update. Once a DID is the authority, or the `{authorDid}` segment of a space URI, it is
sealed into every reply's CID at write time and can't be reassigned. So the choice between
facet and authority has to be made per author, before their first kept write; it can't be
deferred into a later migration. That is why audience replies stay facets (D2): a replier
who later links a DID can be attributed without anything being rewritten.

### D5 — Attribution is owned by the app

The app holds the mapping from its opaque ids to people. Vox Pop's `users` table holds the
phone number and linked DID against a random uid, and only the uid ever reaches Antiphony.
An export carries opaque ids. This is option 2 of
[#121](https://github.com/bbthorson/antiphony/issues/121), and it is what "the app can
leave with its corpus" promised, no more: an export doesn't attribute itself.

## Honest tradeoffs / where B hurts (ranked)

1. **Escape hatch oversold.** B sells *"the app can leave Antiphony,"* **not** *"the user can
   leave the app."* Content can re-home (same CIDs); URIs can't (StrongRefs anchor to the app
   repo), so a user "claiming" their posts gets copies orphaned from their threads. Pre-commit
   to a **re-publication / export-plus-tombstone** framing; never promise user-level migration.
2. **`did:web` fragility** (above).
3. **Corpus concentration** — one DID owns the whole corpus, so takedown/legal pressure lands
   on the repo, not a single record.
4. **Federation norms** may harden around user-repo records, making an app-corpus repo read as
   second-class — but that's crossed later via *additive* dual-write (write app-namespaced
   records into DID-holding users' PDSes via OAuth), from a position where all existing URIs
   are at least *valid* — which the current model would have denied.

## Deferred (decide before the first export)

- **Unsigned-repo gap.** An app DID gives a valid authority but no signed commits / MST — real
  repo verifiability is separable and deferred. Don't let docs imply repo-level attestation: a
  StrongRef CID verifies *content*, not *custody*.
- **Deletion under federation.** Content-addressed records that leave Antiphony don't come
  back → user deletion becomes best-effort tombstoning. Document before exporting anything;
  it interacts with the erasure argument above.
