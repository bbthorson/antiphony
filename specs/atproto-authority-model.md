# AT Protocol authority model

**Status:** decided. First decided 2026-07-03 (app-as-repo-owner, "Model B"), revised
2026-09-24 (spaces, authority by context, minted DIDs) and 2026-10-11 (Vox Pop orgs, the
author segment). This is the current model. How it got here, including the arguments for
each step, is in [`archive/atproto-authority-model-history.md`](./archive/atproto-authority-model-history.md).

**Companions:** [`spaces.md`](./spaces.md) (how spaces are built),
[`did-plc-and-multi-did-tenancy.md`](./did-plc-and-multi-did-tenancy.md) (minting and holding
more than one DID), [`cross-repo-design.md`](./cross-repo-design.md) (how Vox Pop and Bardcast
use all of this).

**Nothing in the corpus is permanent yet.** Reply StrongRefs seal a parent's URI into the
reply's CID at write time, so every rule below is free to change until the first post someone
commits to keeping, and impossible to change after.

## The rules

1. **Authority is custody, not authorship.** The DID in the `at://` authority position says
   who keeps a record. Who wrote it is an attribution facet. The two are never conflated.
2. **Antiphony holds a record only under a DID whose document names it.** The custody check:
   the DID document's `#atproto_space_host` (or, while tenants migrate, `#atproto_pds`) entry
   points at Antiphony. A tenant pins each such DID; Antiphony snapshots the resolved document
   and never re-resolves it on the request path.
3. **Attribution stays out of the CID.** `authorId` (the app's opaque id for a person) and
   `authorDid` are stamped on a post outside its canonical record, so they can be filled in,
   corrected or severed later without rewriting anything.
4. **The app owns attribution.** The app holds the mapping from its opaque ids to people
   (phone numbers, linked DIDs). Only the id reaches Antiphony, and an export carries ids only
   the app can resolve.
5. **Inside a space, the author segment is the authority's DID.** A person is a facet there
   too, never a URI segment (D8).

## D1 — Spaces are adopted

Decided 2026-09-24. atproto spaces are how Antiphony holds audio that isn't public.
Spaces are access control, not encryption: Antiphony can read what it hosts. A record is
either flat (public, `at://{authority}/{collection}/{rkey}`) or placed in a space; its
visibility is the space's read policy, never a field on the record. See [`spaces.md`](./spaces.md).

## D2 — Authority is chosen by who should keep the post

| Who posts | `at://` authority | Author | Who keeps it |
| :--- | :--- | :--- | :--- |
| A Vox Pop prompt from an **org** account | the org's DID (minted, D3) | the creator, as a facet | the org, including after the creator leaves |
| A Vox Pop prompt posted **personally** | Vox Pop's app DID | the creator, as a facet | Vox Pop. The creator may also publish a copy to their own PDS. |
| An **audience reply** to a Vox Pop prompt | the prompt's authority, in the prompt's reply space (D7) | the replier's opaque `authorId`, plus `authorDid` when known | whoever keeps the prompt |
| **Bardcast campaign** content (prompts, replies; Bardcast's own seat, action, state-event and chapter records) | Bardcast's DID, in the campaign's space | the player, as a facet (D8) | the campaign |
| A **Bardcast character-creation** recording | Bardcast's DID, in the player's private space | the player, as a facet (D8) | Bardcast |
| A **Bardcast character** (profile, sheet versions, voice profile) | the player's own DID, in their own repo | the player | the player. Not Antiphony posts (D6). |

A person's own DID is never an authority for a record Antiphony holds. A Bluesky user's DID
names their own PDS, and few people would add Antiphony to their DID document, so the custody
check (rule 2) fails. Records a person should own outright go in their own repo, written by
the app with their OAuth session.

## D3 — DIDs are minted by default, and owning yours is a paid upgrade

- **New tenants and orgs get an Antiphony-minted `did:plc`**, with the owner holding the
  highest-priority rotation key and Antiphony a lower-priority operational key. The document
  names Antiphony as space host and publishes an `#atproto_space` key from genesis.
- **Own-domain `did:web` stays accepted** for tenants (Vox Pop's is `did:web:did.voxpop.audio`).
  It is the method with the strongest exit story: the tenant controls the document, so it can
  repoint its space host and keep every URI valid. Hosted `did:web` under Antiphony's domain is
  not offered, except for throwaway tenants.
- **"Own your DID" claims the minted DID; it never switches to another.** Claiming means taking
  the top rotation key and attaching a custom handle. A switch would give every existing post a
  new authority and orphan every reply pointing at it. It is app-tier and paid where the app
  says so; Antiphony is unaware of tiers.
- **Antiphony does not mint DIDs for end users.** Both apps sign people in with their own AT
  Protocol account, and SMS repliers stay facets (D4).

## D4 — A person's DID is reassignable only while it's a facet

`authorId` and `authorDid` are outside the record CID, so changing them is a plain update.
Once a DID is an authority or a URI segment, it is sealed into every reply's CID. That is why
people stay facets everywhere Antiphony holds records (D2, D8): a replier who later links a DID
can be attributed, and a mistaken attribution can be corrected, without rewriting the corpus.
Minting DIDs for SMS repliers would instead create a permanent public identity for someone whose
only act was replying to a text.

## D5 — Attribution is owned by the app

The app holds the mapping from its opaque ids to people. Vox Pop's `users` table holds the
phone number and linked DID against a random uid, and only the uid ever reaches Antiphony.
This is option 2 of [#121](https://github.com/bbthorson/antiphony/issues/121): "the app can
leave with its corpus", no more. An export doesn't attribute itself, and an org that leaves Vox
Pop takes its replies with opaque ids unless Vox Pop also hands over the map.

## D6 — Bardcast characters (2026-10-07)

- **A character belongs to the player.** The profile, the sheet (a chain of immutable versions,
  each pointing at the last with `prev`) and the voice profile are Bardcast records in the
  player's own repo, written with the player's OAuth session. Antiphony holds none of them. They
  are public, like any repo record.
- **A campaign space holds more than replies.** Next to the audio posts, Bardcast keeps its own
  records under the same space: a seat per character, an append-only action log, state events
  and chapters. Antiphony stores only the posts. Bardcast is the repo host for its own records
  ([`cross-repo-design.md`](./cross-repo-design.md) §3.1); until a third party reads a campaign,
  they live in Bardcast's state.
- **Character-creation recordings go in a private space per player**: type
  `{bardcast root}.space.player`, `skey` the player's DID, `managing-app` policies, created when
  the player starts their first character. The raw recordings stay with Bardcast; what travels
  with the player is what's in their own repo.

## D7 — Vox Pop orgs and reply spaces (2026-10-11)

Decided by Brad. The full model is in Vox Pop's `specs/organizations.md` § 0.

- **An org has its own minted DID** (D3) and owns the prompts posted from its account. The
  creator stays the author. The newspaper model: the article lives at the paper, the reporter
  is the byline.
- **Prompts stay public, outside any space.** A prompt is meant to be seen and answered
  everywhere, so relays, AppViews, unfurls and embeds must reach it.
- **Each prompt's replies live in a reply space for that prompt**, under the prompt's authority:
  `at://{authority}/space/audio.voxpop.space.replies/{promptRkey}`. The org keeps its replies as
  well as its prompts; Vox Pop keeps the id map (D5).
- **Access is Vox Pop's decision**, through `managing-app` policies: the prompt's author, org
  members when the prompt's replies are open to the org, and people the author approved. Never
  anyone outside the org. Antiphony never learns what an org is.
- **Needs from Antiphony:** a reply may sit in a space when its parent prompt doesn't
  ([`cross-repo-design.md`](./cross-repo-design.md) §3.2), and writes under an authority other
  than the tenant's pinned app DID ([`did-plc-and-multi-did-tenancy.md`](./did-plc-and-multi-did-tenancy.md)).

## D8 — The author segment is the authority's DID (2026-10-11)

Decided by Brad. A space record's URI has an author segment:
`at://{authority}/space/{type}/{skey}/{author}/{collection}/{rkey}`. For everything Antiphony
holds, that segment is the **authority's DID**, and the person who recorded it is the
`authorId` / `authorDid` facet.

Why: a space repo commit is the author's signed claim about their records (`@atproto/space`'s
`verifyCommit`; HappyView checks it against the author segment's key). Readers also find an
author's records by resolving the author's DID to its host. With a person's own DID in the
segment, readers would ask that person's PDS, which holds nothing, and Antiphony couldn't sign
for them. With the authority's DID, readers find Antiphony and get commits signed with the
`#atproto_space` key Antiphony holds for that authority.

This replaces the earlier rule ("the acting actor's DID goes in the author segment") in
[`spaces.md`](./spaces.md), which the Phase 1 code implemented. Built in API contract 0.9.0
(2026-10-11), before anyone kept a recording.

## Antiphony is not a PDS

Decided 2026-08-21. Antiphony doesn't serve `com.atproto.repo.*` or `com.atproto.sync.*` over
signed MST commits, and isn't becoming a PDS to make a DID document's claim true. Tenants name
it with `#atproto_space_host`, which describes what it is: the host of a space authority's
repos. `#atproto_pds` is still accepted so no tenant breaks in transit; `validate-pins.ts` names
the tenants still on it. In Phase 3 Antiphony serves the space protocol's own sync surface
(`com.atproto.space.*`), which is a different thing from a PDS.

## Tradeoffs, ranked

1. **"The app can leave" is not "the user can leave the app."** Content can be re-homed (same
   CIDs, because attribution is out of the hash); URIs can't, because StrongRefs anchor them to
   the authority. Never promise user-level migration of posts. A Bardcast player's portable part
   is their character, in their own repo; a Vox Pop creator's is their authorship facet.
2. **`did:web` fragility.** A lapsed domain or rebrand orphans the identity, and document drift
   is indistinguishable from a hijack. Drift detection is a requirement, not yet implemented
   ([#117](https://github.com/bbthorson/antiphony/issues/117)). Minted `did:plc` doesn't have the
   problem.
3. **Corpus concentration.** One DID can hold a whole corpus, so takedown or legal pressure
   lands on that authority rather than one record.
4. **Federation norms may favour user repos.** If the network comes to read app- or org-held
   records as second-class, the answer is additive: write records into users' own PDSes with
   their OAuth session (Vox Pop already plans an opt-in copy of personal prompts).

## Deferred: decide before the first export

- **Verifiability.** Until Phase 3, records carry no signed commits; a StrongRef CID verifies
  content, not custody. Docs must not imply repo-level attestation before then.
- **Deletion under federation.** Records that leave Antiphony don't come back, so a user's
  deletion becomes best-effort tombstoning. Document it before exporting anything.
