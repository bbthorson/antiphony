# AT-Proto authority model — app-as-repo-owner (Model B)

**Status:** decided 2026-07-03. Foundational data-model decision that
[`core-bff-boundary.md`](./core-bff-boundary.md) (the seam) and B3 depend on.
Informed by a Fable design review of `buildPostUri`/`canonicalPostRecord` and the
`ActorIdentityRecord` design.

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
- **User DID + `authorId`:** attribution, stamped as facets, **out of the record CID** and
  out of the URI — so they stay mutable and backfillable.
- **The attribution table is part of the exportable corpus.** The `ActorIdentityRecord`
  (actor↔DID) mapping **stays in Antiphony** and is a first-class exportable artifact (or
  projected into a sidecar record at export time), so an exported app repo still has
  joinable per-user attribution. **This reverses the earlier "move actor↔DID to the BFF"
  lean:** under B's portability goal, attribution must travel *with* the corpus — which
  lives here, not with the BFF that stays behind.

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
  `resolveReplyParticipants`).
- rkeys (`newPostId()`): guarantee unique-per-tenant, ideally TID-shaped so ecosystem sort
  tools work.

## App DID method (sub-decision — decided 2026-07-03)

**Vox Pop beta uses an own-domain `did:web` (`did:web:voxpop.com`), behind a
method-agnostic per-tenant pinning layer.**

**Why `did:web`, precisely:** not cost — **exit sovereignty**. `did:web:voxpop.com` is the
only option where the app can leave Antiphony with *zero cooperation from us*: Vox Pop
controls voxpop.com, so it controls the DID document, so it can repoint the
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

**The revisit deadline is the first Vox Pop post we commit to keeping** — i.e. the
end-of-beta keep-or-wipe call (effectively GA). `did:web:voxpop.com` is provisional exactly
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

**BFF prerequisite:** Vox Pop serving `/.well-known/did.json` on voxpop.com is a **beta
onboarding prerequisite** — it belongs on the coupled BFF work list next to the B3 cross-repo
items in [`core-bff-boundary.md`](./core-bff-boundary.md).

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
