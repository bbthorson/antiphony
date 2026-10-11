# Antiphony, Vox Pop and Bardcast: cross-repo design

**Status:** decided 2026-10-11 (Brad); nothing here is built. It sets how Antiphony, Vox Pop
and Bardcast fit together and what each repo changes. Read against `bbthorson/antiphony`,
`bbthorson/vox-pop` (`920e7de`) and `bbthorson/bardcast` (`9d12198`).

**The bet this serves.** Vox Pop and Bardcast are betting that AT Protocol takes off and that
being native to it is what sets them apart. So where a choice is between "works today" and
"is a correct atproto citizen when someone else's app shows up", this note leans to the
second, as long as the first still works.

## Decisions

| # | Question | Decision | Repo | When |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Is Antiphony XRPC-only? | No. REST is the tenant surface; XRPC is the protocol surface (§2). | antiphony | Low |
| 2 | May a reply be placed in a space when its parent isn't? | Yes, when the space is at least as restrictive as the parent's placement (§3.2). | antiphony | Unblocks Vox Pop |
| 3 | Do Vox Pop replies go into spaces? | **Decided 2026-10-11:** yes, one space per prompt, under the org's DID for org prompts, Vox Pop as managing app (§3.3). | vox-pop | Before replies are exported or federated |
| 4 | Whose DID is a space record's author segment when Antiphony hosts it? | **Decided 2026-10-11 (option A):** the authority's DID, with the person as a facet (§4.2; authority model D8). | antiphony, bardcast | Implement before Bardcast keeps its first recording |
| 5 | What moves into Antiphony as shared code? | A client package with the service-auth signer, a fake for tests, tenant DID tooling (§5). | all three | Medium |
| 6 | What does Phase 3 contain, and when? | The ordered plan in §4.3; start the parts that don't touch the alpha now. | antiphony | Medium |

## 1. Who owns what

| Layer | Owner | Notes |
| :--- | :--- | :--- |
| Audio posts, blobs, enrichment, URIs, signed playback | Antiphony | Headless. Never sees a phone number, a session, an org or a campaign. |
| Space protocol plumbing: URIs, policies, credentials, sync | Antiphony | Built on `@atproto/space` and `@atproto/syntax` (`spaces.md`). |
| Who may hear what | Each app | Through the `managing-app` policy. Antiphony asks; it never decides. |
| End-user sign-in (AT Proto OAuth, SMS OTP) | Each app | `@bbthorson/atproto-cf-auth`, Vox Pop's phone layer. Antiphony stays headless. |
| App records (Vox Pop CRM and orgs; Bardcast seats, actions, chapters) | Each app | Bardcast's character records go in the player's own repo (`atproto-authority-model.md` D6). |

This matches the existing specs. The changes below are about the seams between the rows.

## 2. API surface: REST for tenants, XRPC for the protocol

**What exists.** The REST surface (`/api/v1/*`: posts, replies, spaces, upload, the audio
proxy) is what both apps call, through hand-written clients. The XRPC surface has five methods
(`dev.antiphony.audio.getPost`, `getThread`, `createPost`, `reprocessPost`, `getPlaybackUrl`)
and no caller in either app.

**Recommendation: don't go XRPC-only.** Split by audience:

- **REST is the tenant surface.** It carries things no atproto client would call: service
  tokens, acting-actor headers, multipart upload, signed playback for `<audio src>`, the
  `{ success, data }` envelope, and the OpenAPI docs generated from Zod. Moving it to XRPC
  would keep all those Antiphony-specific shapes under new names and add a second error dialect
  during the move.
- **XRPC is the protocol surface,** for callers that are atproto services rather than tenants:
  `getPost` and `getThread` (so another app can render an embed), and in Phase 3 the
  `com.atproto.space.*` and `com.atproto.simplespace.*` methods. Use the protocol's names, not
  `dev.antiphony.space.*` (see "Prior art: HappyView" in `spaces.md`).
- **Drop the planned XRPC mirrors of the spaces REST routes.** Tenants manage spaces over REST;
  third parties get `simplespace` in Phase 3.
- **Typed clients come from §5's client package,** not from switching the transport.

**Revisit when** an atproto app that isn't a tenant needs to write through Antiphony.

**Reconfirmed 2026-10-11 for Vox Pop and Bardcast: both stay on REST.** Most of what they
call has no XRPC form (upload, spaces, reply listing, the audio proxy), so moving would leave
each app on two surfaces with two error dialects for the same work. The protocol surface gets
exercised where it matters, by the conformance harness (§4.3 step 4) with third-party readers,
not by the tenants. Revisit if the apps start reading Antiphony records through generic atproto
tooling, or if a tenant's records start living on its users' own PDSes.

## 3. Spaces across the apps

### 3.1 The protocol's roles, and who plays each

Proposal 0016 separates four roles. Mapping them explicitly answers "should spaces be in
Antiphony or in the apps": both, for different roles.

| Role | What it does | Who plays it |
| :--- | :--- | :--- |
| **Authority** (the DID in `at://{did}/space/…`) | Owns the space; its DID document names the host and the credential key | The tenant's DID (`spaces.md` decision 1). Never Antiphony's. |
| **Space host** (`#atproto_space_host`) | `getSpace`, credentials, the writer list, routing `notifyWrite` | Antiphony |
| **Managing app** (`managing-app` policy) | Answers `checkUserAccess(space, user, access)` | The tenant: Vox Pop or Bardcast |
| **Repo host** | Holds one author's records in the space and signs their commits | Antiphony for audio posts; the app for its own records (Bardcast's seats and chapters) |

### 3.2 Antiphony rule change: a reply may be more private than its parent

`spaces.md` says a reply always lands in its parent's space, so a reply to a flat (public)
prompt is always flat. The rule exists to stop a reply being *less* private than its thread.
It also forbids the opposite case, and that case is exactly what Vox Pop needs.

**Proposed rule:** a reply's placement must be at least as restrictive as its parent's.

- Parent in a space: the reply goes in the same space. Unchanged.
- Parent flat: the reply may be flat, or in a space the tenant names.

A public viewer of such a thread sees the prompt and no replies. The spec called that
"invisible in its own thread". For Vox Pop it's the product: a public prompt whose replies
only the creator's team can hear.

What changes in Antiphony: `resolveReplyBranch` accepts a `space` on a reply to a flat parent.
The audio-placement check stays (the audio must be stored in the reply's space). A reply to a
reply inherits as before. This is an additive contract change (a patch bump).

### 3.3 Vox Pop: replies in a space per prompt

**Today.** An audience reply is written under Vox Pop's app DID with the replier as an opaque
`authorId` (Antiphony D2 and D5; Vox Pop `data-separation.md` §7). A replier verified by SMS
code has no DID, so none is sent; when the phone number matches a user with a linked DID, the
BFF sends it as `authorDid`. All of that is right and stays. The reply is **flat**, though, and
in Antiphony flat means public:

- Its audio URL is stable and unsigned, and it reaches the browser in the reply views the BFF
  hands the dashboard.
- Its URI is `at://{voxPopDid}/dev.antiphony.audio.post/{rkey}`, an ordinary public repo
  record by atproto's meaning. The day the corpus is exported or federated, which is the bet,
  it would publish as public, against Vox Pop's own rule that replies never go on the network.

**Decided (Brad, 2026-10-11).** Each prompt gets a reply space, and its replies go there.
The org decisions behind it are recorded in Vox Pop's `specs/organizations.md` §0; the ones
that touch Antiphony are below.

```
org prompt:   at://{orgDid}/dev.antiphony.audio.post/{rkey}                      (public, no space)
reply space:  at://{orgDid}/space/audio.voxpop.space.replies/{promptRkey}
reply:        at://{orgDid}/space/audio.voxpop.space.replies/{promptRkey}/{orgDid}/dev.antiphony.audio.post/{rkey}
```

- **Prompts stay public, outside any space.** A prompt is like a tweet: the poster wants it
  seen and answered everywhere, so relays, AppViews, unfurls and the embed widget must all
  reach it. Replies from every surface converge in the prompt's reply space.
- **Authority, by who posted the prompt:**
  - **From an org account:** the **org's own DID**, minted by Antiphony (D3) at the org's
    first kept post (`did-plc-and-multi-did-tenancy.md`: minted lazily). The org owns the
    prompt and its reply space, so it keeps both when the creator leaves. The creator stays
    the prompt's author (`authorId` / `authorDid`, outside the CID): the newspaper model, with
    the article at the paper and the reporter in the byline.
  - **Personally:** **Vox Pop's app DID** (decided 2026-10-11). Every creator signs in with
    their own AT Protocol account, but their DID names their own PDS, so it fails the custody
    check; the creator is the author facet, and may also publish a copy to their own PDS.
    Same reply-space shape under Vox Pop's DID.
  - Vox Pop keeps the map from reply ids to phone numbers and linked DIDs (D5) either way, so
    replies under an org's DID carry only opaque ids. This replaces D2's "audience reply →
    the app's DID" row for org prompts.
- **Author segment:** the authority's DID as well, for every reply, including when the phone
  matches a user with a DID. That person's DID stays in the `authorDid` facet, outside the CID, so
  attribution can be added or corrected later without rewriting anything (Antiphony D4). §4.2
  says why the segment shouldn't hold the person's DID.
- **Space type:** `audio.voxpop.space.replies` (decided 2026-10-11): the reverse of
  `voxpop.audio`, the domain Vox Pop controls. It retires the legacy `com.voxpop` root.
- **Key:** the prompt's rkey. One space per prompt rather than per creator or per org.
  - Nothing that can change is sealed into the URI. A per-org space would seal an org id into
    every reply, and a prompt can move between orgs.
  - It matches the access question Vox Pop already asks, "may this person see replies to this
    prompt?"
- **Policies:** `readPolicy` and `writePolicy` both `managing-app`. Vox Pop answers through its
  own tables: the prompt's author; org members when the prompt's replies are open to the org
  (an org default the author can override per prompt); and anyone the author approved through
  Request access. **No guests:** access never extends outside the org. `member-list` wouldn't
  work: protocol members are DIDs, and SMS repliers have none.
- **Creation:** the BFF calls `PUT /api/v1/spaces/{type}/{promptRkey}` when it creates a
  prompt, then names the space on each reply's upload and post. Needs §3.2.
- **What Antiphony must add for this:** minted `did:plc` for orgs (D3, with `#atproto_space_host`
  and `#atproto_space` at genesis); posts and spaces under an authority other than the tenant's
  pinned app DID, with the tenant asserting which of its DIDs a write uses (the multi-authority
  phases of `did-plc-and-multi-did-tenancy.md`); and §3.2.

**How this squares with "orgs are not spaces"** (`organizations.md` §11). That section is right
that an org is not a space: an org is a billing and access construct. The org now has a DID,
but Antiphony still never learns what an org *is*: it sees an authority DID and spaces whose
access Vox Pop decides. The space is the *prompt's reply set*, and the
org only appears inside Vox Pop's answer to `checkUserAccess`. Antiphony still never learns
what an org is. What the space buys:

- The reply audio stops being public: playback becomes signed and expiring.
- The records are correctly private when the corpus leaves Antiphony.
- In Phase 3, another atproto app the creator authorizes (a CRM, an analytics tool) can read a
  prompt's replies with a credential, with Vox Pop's org rules deciding who gets one. That is
  what an org-sharing feature looks like on the protocol, without the protocol knowing about
  orgs.

The §11 caveat stands: spaces are access control, not encryption. Antiphony can read the
replies either way, as it can today.

**Migration.** Existing flat replies keep their URIs: a StrongRef has sealed them, and
`spaces.md` never moves a record between spaces. New replies go into spaces from the switch
on. If production holds only test replies, wipe them instead (the corpus is still wipeable,
`spaces.md` decision 5).

### 3.4 Bardcast: on plan, with three fixes

Bardcast follows `spaces.md` Phase 4: `ensureSpace` puts each campaign and player space with
`managing-app` policies, replies take their prompt's space, and playback URLs are used at once
and never stored. Three things to fix:

1. **A placeholder CID in replies.** `ClientAntiphonyGateway.createReply`
   (`services/orchestrator/src/adapters/antiphony-gateway.ts`) passes `cid: "bafyplaceholder"`
   when the caller has no prompt CID. Antiphony checks the parent reply's URI and space but not
   its CID (`resolveReplyBranch` in `packages/core/services/audio-posts.ts`), so the fake CID is
   sealed into the reply. Fix both sides: Bardcast always passes the prompt's real CID, and
   Antiphony rejects a parent CID that doesn't match the stored record (a 400).
2. **The lexicons overstate where records live.** `campaign.seat`, `campaign.action`,
   `campaign.chapter` and `character.stateEvent` say they're "written into the campaign's
   space", but no service stores them there: they live in Bardcast's D1 database. Per §3.1,
   Bardcast is their repo host. That's a Phase 3 job, not one for now. Until then, the
   descriptions should say the records are *addressed* under the campaign's space.
3. **The author segment** holds the player's DID today. Decided 2026-10-11 (§4.2, option A):
   Bardcast's DID goes there, with the player as a facet. Antiphony's `createPost` changes, and
   Bardcast's docs and lexicon descriptions follow.

Also: Bardcast pins `@antiphony/shared@^0.7.0` and keeps local copies of the space schemas,
waiting for 0.9.0. npm stops at 0.8.0, so 0.9.0 needs publishing (§5).

## 4. Phase 3: Antiphony as a real space host

Phase 3 is the point where another atproto app can read a space: a Bluesky community client
playing a campaign's audio, or a creator's CRM reading their replies. For the bet, this is the
phase that delivers it. Phases 1 and 2 made spaces private; Phase 3 makes them interoperable.

### 4.1 What a third-party read looks like

1. The app has the user sign in with OAuth, asking for a `space:` scope naming the authority
   (Vox Pop's or Bardcast's DID).
2. It resolves the authority's DID document, finds `#atproto_space_host` (Antiphony), and asks
   Antiphony for a delegation token, then a **space credential** (`getSpaceCredential`), signing
   the request with a fresh key (HTTP message signatures).
3. Antiphony checks the read policy. Under `managing-app` it calls the tenant's
   `checkUserAccess` with service auth signed **as the authority**. If the answer is yes, and
   the app passes the space's `appAccess`, Antiphony issues a credential signed with the
   authority's `#atproto_space` key.
4. The app reads records, blobs and sync data with the credential (`getRecord`, `listRecords`,
   `getBlob`, `getRepo`), and registers for `notifyWrite` to stay current.

### 4.2 The author-segment decision (urgent: sealed into URIs)

A space repo commit is the **author's** signed claim about their records. `@atproto/space`
documents `verifyCommit` that way, and HappyView verifies each commit against the signing key
of the author segment's DID (`src/spaces/native_sync.rs`). Antiphony can only produce a commit
that verifies if it holds a key for the author segment's DID.

- **Vox Pop (§3.3):** the segment is Vox Pop's DID, whose `#atproto_space` key Antiphony will
  hold. Works.
- **Bardcast today:** the segment is the player's own Bluesky DID. Antiphony doesn't hold, and
  must never hold, a player's account key. So Antiphony can't sign commits for those records,
  and a third-party syncer can't verify them. The protocol's intended home for a player's
  space records is the player's own repo host, once their PDS supports spaces.

**Options for Bardcast:**

- **A. Authority as author segment, player DID as facet** (the Vox Pop shape). Antiphony signs
  everything it hosts, and sync verifies. The player's authorship is attributed through
  `authorDid` rather than the URI, and it stays correctable (D4). *Recommended for now.*
- **B. Keep the player's DID in the segment,** and accept that Antiphony serves those records
  only through credentialed reads, never verifiable sync, until players' PDSes host their own
  space repos. That needs a later move nobody can promise.
- **C. Have the player sign.** Each write would need the player's key, through their PDS. That
  isn't possible today, and it drops background writes.

**Decided 2026-10-11: option A** ([`atproto-authority-model.md`](./atproto-authority-model.md)
D8). Antiphony's rule changes from "the acting actor's DID goes in the author segment" to "the
authority's DID goes there, and the person is a facet". It applies to every space record
Antiphony holds, Vox Pop's included. The player's portable part is their character, in their
own repo; the campaign recordings were always the campaign's (D2). The code change lands before
Bardcast keeps its first recording.

### 4.3 The work, in order

Each step stands on its own. Steps 1–4 don't touch the moving parts of the alpha and can
start now. Steps 5 onward wait for the alpha to settle or a second app to ask.

| # | Step | Repo | Notes |
| :--- | :--- | :--- | :--- |
| 1 | Settle §4.2 and ship §3.2 | antiphony, bardcast | Sealed URIs first. |
| 2 | **Keys.** Each authority's DID document publishes `#atproto_space` (P-256) next to `#atproto_space_host`; Antiphony holds the private half, sealed at rest, one per authority. The same key signs service auth as the authority (for `checkUserAccess` and `notifyWrite`). | antiphony; tenant DID docs | Design with the operational key in `did-plc-and-multi-did-tenancy.md`. `did:web` tenants (Vox Pop) edit their document; minted `did:plc` gets it at genesis. |
| 3 | **`checkUserAccess` in each app.** A `com.atproto.simplespace.checkUserAccess` endpoint that verifies Antiphony's service auth and answers from app state. Tenants record the endpoint as `managingAppEndpoint` on each space. | vox-pop, bardcast; helper in §5's client | Antiphony keeps skipping the call for tenant-originated reads, as now. |
| 4 | **Conformance harness.** A test instance of HappyView and the Bluesky reference PDS (`pds-spaces-alpha` image) acting as third-party readers against a local Antiphony. | antiphony | Proves interop instead of reading the spec. HappyView is MIT. |
| 5 | **Credentials.** `getDelegationToken` and `getSpaceCredential`, request-signature checks, `appAccess` (`open` or an allow list of `client_id`s), credential lifetime and revocation on loss of read (`notifyCredentialRevoked`). | antiphony | `@atproto/space` covers the crypto; add it with the `overrides` `spaces.md` lists. |
| 6 | **Credentialed reads.** `com.atproto.space.getRecord`, `listRecords`, `getBlob` for `dev.antiphony.audio.post` and its transcripts. | antiphony | Signed playback URLs stay for browsers (`<audio src>` can't sign a request). |
| 7 | **Repos and sync.** Per-author space repo commits (`RepoCommit`, LtHash), `getLatestCommit`, `getRepo`, `listRepos`, `listRepoOps`, `registerNotify`, outbound `notifyWrite`. | antiphony | Needs §4.2 settled. |
| 8 | **Management.** `com.atproto.simplespace.getSpace` for third parties; `putMember`/`removeMember` only if a tenant wants `member-list` spaces. | antiphony | No tenant does today. |
| 9 | **Bardcast's own records** (seats, actions, chapters) in the campaign space: Bardcast as their repo host, notifying Antiphony as space host. | bardcast | Or ask Antiphony to host app records generally. That would widen its scope beyond `dev.antiphony.*` and needs its own decision. |
| 10 | **Discovery.** Advertise the XRPC service in tenant DID documents (`xrpc-and-atproto-lex-strategy.md` Phase 3). | antiphony | |

**Not in Phase 3:** encryption (spaces are access control), nested spaces, and HappyView's
extras (invites, spaces as members, `read_self`).

## 5. Shared code to move into Antiphony

| What | Today | Proposed home |
| :--- | :--- | :--- |
| **A typed client** | Bardcast: `packages/antiphony-client` (295 lines plus 166 of copied response shapes). Vox Pop: `apps/vox-pop-api/src/lib/antiphony-client.ts` (632 lines, tied to Hono). Both re-implement the envelope, errors, acting-actor headers, upload placement checks, reply pagination, and parsing post and space URIs. | `@antiphony/client`, published from this repo, built on `@antiphony/shared`. Framework-free; Vox Pop's Hono proxying stays in Vox Pop. |
| **The service-auth signer** | Vox Pop only (`antiphony-service-auth.ts`, 281 lines). Antiphony owns the verifier. | In `@antiphony/client`. Whoever owns the verifier should own the signer, or Bardcast writes its own. |
| **A `checkUserAccess` helper** | Nobody yet (§4.3 step 3) | In `@antiphony/client`: verify Antiphony's service auth, call the app's decision function, answer in the protocol's shape. |
| **A fake Antiphony** | Vox Pop: `antiphony-stub.ts` (417 lines). Bardcast: `fetch` mocks. | `@antiphony/testing`: an in-memory implementation of the REST contract for local dev and tests. |
| **Tenant DID tooling** | Vox Pop: `scripts/generate-app-did-key.mjs`, `check-app-did-key.mjs`, `infra/did-web/`. Bardcast needs the same before it's a tenant in production. | A CLI or template in this repo, beside `tenant-onboarding.md`, that also writes the `#atproto_space` key (§4.3 step 2). |
| **`@antiphony/shared` 0.9.0** | Unpublished (npm has 0.8.0). Bardcast copies the space schemas meanwhile. | Publish it. |

**Stays in the apps:** AT Proto OAuth (`@bbthorson/atproto-cf-auth`), SMS verification and the
phone ↔ user mapping, orgs and campaigns, the decision inside `checkUserAccess`, and app data
(CRM, sentiment, seats). `@antiphony/capture-kit` is already shared by both apps.

## 6. Sequencing

1. **Now, while URIs are free:** the §4.2 author-segment change in `createPost`; §3.2 rule
   change; Bardcast's CID fix with
   Antiphony's parent-CID check; publish `@antiphony/shared` 0.9.0.
2. **Next:** Vox Pop reply spaces (§3.3); `@antiphony/client` with the signer, then both apps
   move onto it; the Bardcast lexicon wording.
3. **Phase 3 groundwork:** keys, `checkUserAccess` endpoints and the conformance harness
   (§4.3 steps 2–4).
4. **Phase 3 proper,** when the alpha settles or a second app needs to read a space: steps 5–10.

## Open questions

1. **Who hosts Bardcast's app records** in the campaign space: Bardcast, or a general
   app-record host in Antiphony (§4.3 step 9)?
2. **What the protocol settles on for author segments** when a space repo is hosted away from
   the author's own PDS. Option A holds up under today's alpha; recheck each time it moves.
3. **Can a replier hear their own reply?** It's possible under `managing-app`, and it's Vox
   Pop's product decision.

Settled 2026-10-11: Vox Pop's NSID root (`audio.voxpop`), the owner of personal prompts (Vox
Pop's DID), and the author segment (option A).
