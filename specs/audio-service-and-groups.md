# Antiphony as an audio service; groups and who owns a record

**Status:** decided 2026-11-01 (Brad). Step 2 of the work table is built on Antiphony's side
(contract 0.10.1); audio-service mode (step 6) is not. **Revised 2026-11-02** with a finding
from Grain's code: an opensocial group's host is the group's PDS, so Antiphony can never hold
records under a group's DID ("Finding: a group host is the group's PDS", below). That makes
step 6 the critical path. This replaces parts of
[`atproto-authority-model.md`](./atproto-authority-model.md) (rules 2 and 5, D2's Bardcast rows,
D3's minting, D8), [`spaces.md`](./spaces.md) (decision 1 and "The author segment"),
[`cross-repo-design.md`](./cross-repo-design.md) (§3.1's roles, §4.2) and the minting phases of
[`did-plc-and-multi-did-tenancy.md`](./did-plc-and-multi-did-tenancy.md). Each of those docs
says which of its parts this replaces.

**Why now.** Nothing in the corpus is kept yet, and the only user is the project owner, so URIs
and record shapes are still free to change. They won't be after the first kept recording.

## What prompted it

Two atproto.com posts set out how Spaces are meant to be used:

- **"Devex goals for Spaces"** names three uses:
  - *personal-private*: one member, with your own DID as the authority;
  - *syndicated/gated*: a publisher's DID is the authority and does most of the writing;
  - *groups/shared*: the authority is a group DID that belongs to no single person.

  It also introduces the **group host**, which does for a group what a PDS does for a user.
- **"Atmospheric groups"** introduces the community
  [opensocial.group](https://tangled.org/opensocial.group/proposal) proposal: "a DID with a bunch
  of permissioned spaces under it". The group defines and uses its spaces like this:
  - a **meta** space for its profile and rules;
  - a **members** space for members, roles and an index of the group's other spaces;
  - one space per app.

  How the group works:
  - **Membership:** the group writes a membership record and the member writes an acceptance.
  - **Read access:** flat roles. Each space has an access record listing which roles can read
    it, and the group host enforces it when it issues credentials.
  - **Who holds the data:** each writer keeps their records in their own space repo. The group
    host tracks who has written to the space and forwards write notifications, but doesn't
    store members' records.
  - **Acting as the group:** the group host is also the OAuth server for the group's DID, so
    admins act as the group with their own accounts.

The proposal text itself was unreachable when this was written (tangled.org returned 502 for
the repo). Its details are open questions below, not assumptions.

## Finding: a group host is the group's PDS (2026-11-02)

Grain's public code (`github.com/grainsocial/grain` at `0eb252c`, 2026-11-01) is the first
running client of opensocial groups we've read. It shows that **a group is an ordinary AT
Protocol account, and its group host is its PDS**:

- **The DID document names the host as `#atproto_pds`.** `server/helpers/groupHost.ts`
  (`groupHostFor`) resolves the group's DID, reads `#atproto_pds`, and treats that endpoint as
  the group host. There is no separate `#atproto_space_host` or group-host service entry.
- **The host serves `fyi.opensocial.*` from the same origin** and identifies itself with a
  `did:web` at that origin (`/.well-known/did.json`), which is the audience of the service
  auth a member's PDS mints for it. Grain calls `fyi.opensocial.provisionGroup`,
  `fyi.opensocial.createSpace` and `fyi.opensocial.listGroups` there
  (`server/xrpc/createGroup.ts`, `groupListing` and `callGroupHost` in `groupHost.ts`).
- **It is also the space host for all the group's spaces.** Grain asks the group's host to
  create the group's pool space (`createGroup.ts`), and its OAuth scopes reach spaces anchored
  on the group with `space:…?authority=*` (`hatk.config.ts`). Credentials for a group space
  are minted by the authority's PDS (`hatk`'s `spaces/identity.ts`, `spaceHostEndpoint`).
- **Provisioning hands the app a session on the group.** `provisionGroup` returns an OAuth
  session for the new group's account, scoped to what the app's client metadata declares, and
  the app writes the group's own records (Grain's profile) through it, into the group's repo
  on the host.
- **Members' records in a group space live in the members' own repos.** Grain reads a
  member's gallery in the pool from that member's PDS (`server/spaces/client.ts`,
  `resolvePds(repo)`), with a credential the group's host issued.

**What follows for Antiphony:**

- **An opensocial group's DID never names Antiphony.** Its document names the group host, as
  its PDS. Antiphony's custody gate (the pin validator, the `/api/v1/dids` registry and
  writes under a registered DID) requires a document that names Antiphony, so a group's DID
  can't be registered and nothing can be written under it here.
- **Group records, and members' records in group spaces, live in the group's repo on its host
  or in the members' own PDSes.** Antiphony can't hold them. It can only process and serve
  audio those records reference. So **audio-service mode (G2, step 6) is the critical path**
  for Bardcast tables and Vox Pop orgs, not a later clean-up.
- **The temporary repo hosting in G2 and G6 doesn't cover groups.** It still covers DIDs whose
  documents name Antiphony: the app's own DID, and DIDs an app or tenant created that aren't
  opensocial groups (below).

**What contract 0.10.2 and 0.10.3 still serve.** The DID registry (`/api/v1/dids`, #225) and
writes under a registered DID (`authority` on posts and spaces, #226) work for any DID whose
document names this Antiphony: an app- or tenant-created `did:plc` or `did:web` that isn't an
opensocial group. They stay, and work as built. Whether any tenant needs them once
audio-service mode exists is open (open question 6); nothing is removed until that's
answered. Their `role: "group"` value is a name in the contract, not a claim that the DID is
an opensocial group.

The opensocial proposal itself (`tangled.org/opensocial.group/proposal`) was still unreachable
on 2026-11-02 (tangled answered 500 and 502). What's above comes from Grain's and hatk's code,
not the proposal, so treat the proposal's details as unverified.

## G1 — Follow the protocol's split of roles

Antiphony had merged several protocol roles into one service. From here, each role is played by
whoever the protocol expects to play it:

| Role | What it does | Who plays it |
| :--- | :--- | :--- |
| **Identity** | A DID and its document | People: their own AT Protocol accounts. Groups: a group DID (G4). Apps: their app DID. |
| **Repo host** | Holds one author's records and signs their commits | The author's PDS (people), the group host (groups), the app (its own records) |
| **Group host / space host** | Credentials, the list of writers, routing writes, membership and roles | The group's PDS: an opensocial group host, which is also the space host for the group's spaces (finding above). Who runs it is open question 1. |
| **App** | Sign-in, product rules, its own indexes | Vox Pop, Bardcast |
| **Audio service** | Upload, processing, enrichment, renditions, playback, an index of audio it has seen | **Antiphony** (G2) |

## G2 — Antiphony is an audio service

A service any atproto app can use to process and serve audio, rather than the place where
canonical audio records live. As we understand it, Bluesky's video service has the same shape:
it processes an upload and the result lives in the author's repo.

**Keeps:**
- upload;
- the enrichment pipeline (denoise, trim, transcribe, waveform);
- mp3 renditions;
- signed, expiring playback (`<audio src>` can't sign a request, so signed URLs stay);
- enrichment webhooks;
- an index of the posts and threads it has processed, for the reads apps already make.

**Changes:**
- **Where records and blobs live.** The canonical `dev.antiphony.audio.post` record and its blob
  live in the authority's repo, wherever that is hosted.
- **How Antiphony reads.** It reads spaces it has been granted, as an app holding a space
  credential.
- **Derived data.** Antiphony publishes what it derives (transcripts, processing state). Where
  those records go is open question 3.

**Goes away once nothing depends on it:**
- `createPost` deciding URIs;
- custody pinning (`ANTIPHONY_APP_DIDS`, the DID-document hash gate, `#atproto_space_host`
  naming Antiphony);
- Antiphony minting DIDs (a group host's job);
- Phase 3 as written in `spaces.md`, where Antiphony would be the space host.

**Hosting repos is a separate, temporary role.** Until people's PDSes can hold space repos,
someone has to host repos for app DIDs. Antiphony keeps doing that, behind a boundary that can
be removed without touching the audio API. *Revised 2026-11-02:* it can't do it for group
DIDs. An opensocial group's DID names its group host as its PDS (finding above), so only that
host can hold the group's repo. Antiphony's hosting covers DIDs whose documents name it.

## G3 — Who owns a record

**Members own what they write. The publisher keeps what outsiders send. Generated work belongs
to the group.**

- **A member** of a group (a Bardcast player at their table) authors their contribution under
  their own DID. It is theirs: if they delete it or leave, it goes.
- **An outsider** answering a publisher (a Vox Pop replier) contributes to the publisher's space.
  The publisher keeps it, and the person is credited through the `authorId` / `authorDid` facet.
- **A work the app generates** for a group belongs to the group, authored by the group's DID.
  Example: a Bardcast chapter, written and rendered by Bardcast in the players' cloned voices.
  It stays when a player leaves. Joining a table means agreeing to that, and Bardcast's join
  flow must say so.

## G4 — Shared contexts are atmospheric groups

- **Bardcast: the group is the table**, the friends who play together. A campaign is a space
  key under the table's DID, so one table can run several campaigns with the same members.
  Roles specific to a campaign, like who is DM, live in Bardcast's own lexicons and point at
  the group's roles.
- **Vox Pop: the org is a group.** Its profile goes in the meta space, and owner / admin /
  member are its roles. Invites by handle or DID become the group's membership record plus the
  member's acceptance. The source of truth for membership moves to the members space, and
  Postgres becomes an index of it.
- **Not groups:** a Vox Pop personal prompt (Vox Pop's DID, syndicated) and a Bardcast player's
  creation recordings (personal-private, G5).
- **Fine-grained access stays with the app.** Flat roles can't express Vox Pop's "private to the
  author, open per prompt, plus people the author approved". Reply spaces keep `managing-app`
  policies, under the org's DID. *2026-11-02:* the org's DID names its group host, so the
  reply spaces are the host's, not Antiphony's; whether a group host accepts a `managing-app`
  policy is open question 2.

## G5 — The author segment follows ownership (replaces D8)

D8 put the authority's DID in every space record's author segment, because Antiphony can't
sign for a person. G3 says some records are the person's, so their DID goes in the author part
of the URI:

| Record | URI | Author segment |
| :--- | :--- | :--- |
| Bardcast campaign prompt (asked by the DM, a member) | `at://{tableDid}/space/{campaignType}/{campaignId}/{dmDid}/…` | the DM's DID |
| Bardcast player reply | `at://{tableDid}/space/{campaignType}/{campaignId}/{playerDid}/…` | the player's DID |
| Bardcast chapter, seat, action log, state events | `at://{tableDid}/space/{campaignType}/{campaignId}/{tableDid}/…` | the table's DID |
| Bardcast creation recording | `at://{playerDid}/space/{playerType}/{skey}/{playerDid}/…` | the player's DID (personal-private) |
| Vox Pop org prompt | `at://{orgDid}/dev.antiphony.audio.post/{rkey}` (flat, public) | — |
| Vox Pop personal prompt | `at://{voxPopDid}/dev.antiphony.audio.post/{rkey}` | — |
| Vox Pop reply | `at://{authority}/space/audio.voxpop.space.replies/{promptRkey}/{authority}/…` | the prompt's authority (unchanged) |

Bardcast's narrator prompts during creation are posted by Bardcast into the player's personal
space. Whether a personal-private space accepts a second writer is a protocol detail to check
(open question 2).

## G6 — Hosting can move; URIs can't

A URI names a DID, not a server, and the DID document says where the data lives. Moving a repo
keeps every URI, as long as the DID, collection and record key stay the same. So:

- **Records authored by a person are hosted for them until their PDS can hold spaces.** Today
  that's Antiphony's temporary repo hosting, or Bardcast for its own collections.
  *2026-11-02:* only for spaces whose authority's DID names Antiphony. A space under a group's
  DID is on the group host, and a member's records in it go in their own PDS once it holds
  spaces; until then they can't be written into that space at all. They are
  served only to the app that wrote them. Third parties can't sync and verify them, because no
  one but the person can sign their commits. When the person's PDS supports spaces, the app
  writes the same records there with the person's OAuth session: same URI, same CID.
- **To exercise the native path now,** run the spaces-alpha reference PDS for test accounts.
- **What is sealed is the DID in each URI segment**, which G5 settles. Where records are hosted
  is not sealed.

## G7 — Vox Pop replies may sign in with AT Protocol

A replier may prove who they are with an SMS code or with AT Protocol sign-in. Whether
unverified replies are allowed is a separate screening question for Vox Pop. Either way the
reply is kept by the prompt's authority (G3, outsider). A signed-in replier's DID fills
`authorDid`, which can be corrected later. Signing in also gives Vox Pop a natural way to let
someone hear their own reply.

## G8 — Naming

- **The lexicons keep the Antiphony name.** "Call and response" describes
  `dev.antiphony.audio.*`, and the `antiphony.dev` domain must stay registered because the NSIDs
  name it.
- **The service may get a plain name** in the style of `atproto-cf-auth`, e.g.
  `atproto-cf-audio`, because an audio service is wider than call and response. Not decided. It
  would touch the repo, `@antiphony/shared`, `api.antiphony.dev` and the docs site, so it waits
  until the rest of this lands.

## The work, in order

| # | Step | Repo |
| :--- | :--- | :--- |
| 1 | Record these decisions and mark what they replace (this change). | all three |
| 2 | **The sealed part first.** `createPost` takes the author segment the caller names, from the acting actor, when the record is a member's (G5), instead of always the authority. Bardcast names it for campaign posts and creation recordings. *Antiphony's side built 2026-11-01: `spaceAuthor: 'actor'` (API contract 0.10.1).* | antiphony, bardcast |
| 3 | **Group DIDs.** The table's and the org's DID as authority, on a group host (open question 1). *Corrected 2026-11-02:* a group's DID names its group host as its PDS, so its records can't be written through Antiphony; they go in the group's repo on the host, or in members' own PDSes. Antiphony's part is step 6. Contract 0.10.2–0.10.3 (register a DID, then name it as `authority`) serve only DIDs whose documents name Antiphony, not opensocial groups (finding above). What remains here: choose a group host and provision groups on it, from Bardcast and Vox Pop. | bardcast, vox-pop |
| 4 | **Bardcast's chapter and join consent** (G3): the join flow says chapters stay with the table. | bardcast |
| 5 | **Vox Pop members from the members space** (G4): membership records and acceptances, with Postgres as an index. | vox-pop |
| 6 | **Audio service mode** (G2): process audio referenced by records in other repos, read with a space credential, and publish derived records. **The critical path** since the 2026-11-02 finding: it is the only way Antiphony processes a group's audio. | antiphony |
| 7 | **Move member-authored records to members' PDSes** as they gain spaces support (G6). | bardcast |
| 8 | **Retire custody pinning and Antiphony's repo hosting** once nothing is hosted there. | antiphony |

Step 2 must land before Bardcast keeps its first recording.

## Open questions

1. **Who runs group hosts.** *Narrowed 2026-11-02:* the group host is the group's PDS (finding
   above), so Antiphony's temporary repo hosting is not an option. What's left is whose host:
   self-host the opensocial.group reference, or use someone else's. Not sealed: a group can
   move hosts, as any account can move PDS. Whoever creates a group DID must give its top
   rotation key to the app acting for the group (and through it, the group), so the group can
   move later.
2. **What the proposal says**, once readable (still unreachable 2026-11-02):
   - whether a member's acceptance must be written from their own PDS;
   - whether a group's spaces can sit on more than one host;
   - whether a personal-private space accepts a second writer (Bardcast's narrator);
   - whether a group host accepts a `managing-app` read policy (G4), or only flat roles.
3. **Where derived records live:** transcripts and processing state as records in the same
   space under Antiphony's DID, or only in Antiphony's index.
4. **A player deletes a reply a chapter used.** The chapter stays (G3), and the reply's
   StrongRef in Bardcast's action log dangles. Bardcast decides whether it shows a gap or
   nothing.
5. **The service's name** (G8).
6. **The future of the DID registry and `authority`** (contract 0.10.2–0.10.3). They serve
   DIDs whose documents name Antiphony and that aren't opensocial groups. Keep them as a
   general feature, narrow them, or retire them with custody pinning (step 8). Decide once
   audio-service mode exists and a tenant has said whether it needs them.
