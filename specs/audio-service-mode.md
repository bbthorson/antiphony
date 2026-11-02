# Audio-service mode: processing audio whose record lives elsewhere

**Status:** **Phases A, B and C approved and built 2026-11-02** (contracts 0.10.4, 0.10.5
and 0.10.6; "Phase A as built", "Phase B as built" and "Phase C as built", below).
- Open question 3 is settled: tenant scoping for Phase B (Brad, 2026-11-02), and a delegation's
  proof of access for Phase C.
- Phase C was verified against the reference implementation and the opensocial proposal's
  text, **not yet against a running opensocial host** ("Phase C verification", below; open
  question 2 answered). Rerun that against `opensocial.fyi` before the first group uses it.

This is
step 6 of the work table in [`audio-service-and-groups.md`](./audio-service-and-groups.md)
(G2), which the 2026-11-02 finding there (#227) made the critical path: an opensocial group's
DID names its group host as its PDS, so Antiphony can't hold a group's records or members'
records in a group's spaces. It can only process and serve the audio those records point to.
This spec says how.

Each **D-n** below gives a recommendation and the main alternative. Approving Phases A and B
settled D-1, D-2, D-4 to D-7 and the Phase B half of D-3; D-3's Phase C (delegation
hand-off) is held with Phase C. Nothing here seals a URI. Contract changes are additive and
are listed in §11.

## 1. The shape

Today a tenant **creates** a post here: Antiphony mints the URI, holds the record, stores the
blob and processes it. In audio-service mode the tenant **registers** a post that already
exists somewhere else, and Antiphony does everything except hold the record:

```
app (Bardcast, Vox Pop)                    record's repo host                  Antiphony
  │  1. upload blob, write record ───────▶ player's PDS, or the group's
  │     (member's or group's session)       repo on its group host
  │  2. register {uri, cid} ────────────────────────────────────────────▶ fetch + verify record
  │                                                                        get the blob (§4)
  │                                                                        index it (§5)
  │                                                                        process (§6)
  │  ◀──────────────────────────────── webhooks, views, signed playback ─┘
```

Bluesky's video service has the same split: the service processes, and the result is
referenced from a record in the author's repo. Antiphony never writes into another repo
(D-7).

**Where the record can be:**

| Case | Example | Record at | Blob readable by |
| :--- | :--- | :--- | :--- |
| **Public repo record** | A Vox Pop org prompt, `at://{orgDid}/dev.antiphony.audio.post/{rkey}` | The authority's PDS (for a group, its group host) | Anyone: `com.atproto.sync.getBlob` |
| **Space record, member-authored** | A Bardcast player's reply, `at://{tableDid}/space/{type}/{campaign}/{playerDid}/…` | The player's own PDS, in its space repo | A space credential the table's group host issues |
| **Space record, group-authored** | A Bardcast chapter, or a Vox Pop reply kept by the org | The group's repo on its group host | The same |

## 2. Prior art

- **Grain** (`grainsocial/grain` at `0eb252c`), `server/spaces/client.ts`. Grain reads a group
  pool in two ways. A member reads their own repo through their own session. Anyone else reads
  with a space credential: the record from the **writer's** PDS (`resolvePds(repo)`), and the
  writer set from the **authority's** PDS. A space record has no `uri` on the wire, so the
  reader builds one from the space, repo, collection and rkey. Blob refs come in two spellings
  (`$link` and DAG-JSON `/`), and Grain reads both (`blobCid`).
- **hatk** (`hatk-dev/hatk` at `2174631`), `packages/hatk/src/spaces/`. hatk is an indexer
  and is a member of nothing, which is Antiphony's position too.
  - **Credentials** (`credential.ts`). hatk reads "as somebody who is already inside". The
    reader's PDS signs a **delegation token** (60 s, single use, addressed to the authority's
    PDS). The authority exchanges it at `com.atproto.space.getSpaceCredential` for a
    **credential** (about 10 min) bound to a key the requester names (`credentialKid`). Every
    request then carries an HTTP message signature over the credential and the repo it's
    addressed to. A `getRecord` also carries a MAC request against the writer's
    `#atproto_kem` key (`mac.ts`), which the reference host requires (checked 2026-11-02).
  - **Public spaces.** A space whose read policy is public gets a credential with no
    delegation (`mintPublicSpaceCredential`).
  - **Space blobs** (`blob.ts`). They are served only through an authorized proxy and never
    given a public URL, "since giving one a public URL would turn that URL into the
    capability the credential exists to replace". hatk checks the MIME type itself rather
    than trusting the writer's.
  - **Write notices** (`notify.ts`). `notifyWrite` is best-effort and carries no records.
    "Nothing here may be load-bearing": a reconcile sweep is what makes sync correct.
- **The opensocial proposal** (a copy Brad supplied on 2026-11-02; its tangled.org repo is
  still 502) and the atproto team's two posts about it
  ([intro](https://atproto.com/blog/atmospheric-groups-intro),
  [vision](https://atproto.com/blog/open-social-groups-vision)). A group is a DID with spaces
  under it, hosted by an opensocial host that enforces role-based read access when it issues
  credentials. "Phase C verification" has what that settles.
- **HappyView** ([`spaces.md`](./spaces.md) "Prior art"). It confirms the wire names
  (`com.atproto.space.getBlob`, `getSpaceCredential`, `getDelegationToken`), and that
  `<audio src>` can't carry an HTTP message signature. So **signed playback URLs stay** for
  browsers whatever reads the blob upstream.

## 3. Registering a post (D-1, D-2)

**D-1. The tenant registers `{ uri, cid }`, and Antiphony fetches the record itself.**
*Recommended.*

```
PUT /api/v1/remote-posts
{ "uri": "at://…", "cid": "bafy…", "processing": { … }?, "bytesFrom": "upload" | "fetch"? }
```

- **Why not trust a record body the tenant sends?** The URI and CID go into Antiphony's
  index, its views and its webhooks, so Antiphony has to read the record from where the URI
  says it lives. Fetching it gives three things:
  - the record's location is checked: it's resolved from the DID document, not taken from
    the tenant;
  - its content is checked: the CID is recomputed from the fetched record and must equal
    `cid`;
  - its shape is checked: it must be a valid `dev.antiphony.audio.post`, with a
    `dev.antiphony.embed.audio` blob ref.
- **The exception: a space record the tenant pushes** (§4.2, before Antiphony can read spaces
  itself). There the tenant sends the record body. Antiphony checks it against `cid`, which
  proves content but not custody. That is the same gap a StrongRef already accepts.
- **Idempotent.** The same `{uri, cid}` again is a no-op. The same `uri` with a new `cid`
  means the record was edited (§8.2).
- **Collection.** `dev.antiphony.audio.post` only, for now. Audio in another app's collection
  (a Bluesky post with a video-style embed, say) is a later question.
- **Tenant-scoped.** Two tenants may register the same URI. Each gets its own index row, blob
  copy and processing, as everything here is per tenant.
- **XRPC.** A `dev.antiphony.audio.registerPost` procedure mirrors the route, as
  `createPost` mirrors `POST /posts` ([`xrpc-surface.md`](./xrpc-surface.md)).

*Alternative:* register by blob alone (`{ blobCid }`), with no record. This is simpler, but
Antiphony would then know nothing of the thread, the authority or the space. Signed
playback, thread reads and deletion all need those, so no.

**D-2. Name: "remote posts", routes under `/api/v1/remote-posts`.** "Remote" means held
outside Antiphony. Reads take the URI as a query parameter (`?uri=`), because an `at://`
URI doesn't fit in a path segment. *Alternative:* fold them into `/api/v1/posts` with
`?uri=`. That reads better, but the hosted routes are keyed by `postId`, a bare rkey, and two
repos can share an rkey (§5.1). Keeping remote posts on their own routes until hosting is
retired (step 8) avoids that ambiguity.

## 4. Getting the blob (D-3, D-4)

### 4.1 Public records: Antiphony fetches

1. Resolve the record's repo DID (the URI's authority for a repo record) to its
   `#atproto_pds`, with the same resolver the pin validator uses (`did:plc` and `did:web`).
2. `com.atproto.repo.getRecord` there. Check the CID (§3).
3. `com.atproto.sync.getBlob?did=…&cid=…`.
4. Check the downloaded bytes. Their CID must equal the blob ref's: both are CIDv1, raw,
   sha2-256, the same scheme `lib/cid.ts` uses for uploads. Check size too.
5. Check the MIME type from the bytes, not from the record (as hatk does).

Fetch guards:
- HTTPS only;
- a timeout and a byte cap, the same cap upload has;
- no redirects to another host;
- every failure classified **unreachable** vs **gone**, as the pin validator does (§8.1).

### 4.2 Space records: who obtains the credential (D-3)

A space credential needs a delegation token. Only a PDS session for someone the authority
admits can mint one. Antiphony has no such session, and shouldn't: it would become an OAuth
client holding people's sessions, which is exactly what the headless boundary rules out
([`core-bff-boundary.md`](./core-bff-boundary.md)). The tenant holds them already. So:

**D-3. The tenant obtains access, and Antiphony never holds a session.** *Recommended*, in
two steps:

- **Phase B: the tenant pushes the bytes.** The tenant already reads the space for its own
  product, so it uploads the bytes it read: `POST /api/v1/audio/upload` with a new
  `remoteSpace` field naming the space URI (`at://{authority}/space/{type}/{skey}`). That marks
  the blob private (§7) without a registered Antiphony space. Then it registers with
  `bytesFrom: "upload"` and the record body. Antiphony checks that the blob ref's CID equals
  an uploaded blob of that tenant, marked private for that same space. Needs no
  `@atproto/space`.
- **Phase C: delegation hand-off** (*verified 2026-11-02 against the reference
  implementation; built 2026-11-02, "Phase C as built"*). The tenant asks the member's PDS for a delegation token
  for the space (`com.atproto.space.getDelegationToken`) and passes it with the registration
  (`delegationToken`). The token is single-use and lives 60 s, so it's spent at once.
  - **The exchange.** Antiphony posts the token to `com.atproto.space.getSpaceCredential` at
    the authority's `#atproto_pds` (its group host). The token names its audience as
    `{authority}#atproto_pds`, but it doesn't name a key. So Antiphony names **a P-256 key it
    generates and holds** (`credentialKid`, a `did:key`), and the credential is bound to that
    key. The tenant never sees the key, and the credential is useless without it.
  - **The credential** is signed with the authority's `#atproto` key and lives 600 s (the
    library's cap is an hour). It can't be renewed: a fresh one needs a fresh delegation,
    unless the space is publicly readable.
  - **Reads.** Antiphony signs every request for the repo it's addressed to
    (`atproto-space-audience`, an RFC 9421 signature over the credential and that DID), and
    sends it to the **writer's** PDS.
    - `com.atproto.space.getRecord` **also requires a MAC request**
      (`atproto-space-want-mac`). Antiphony encapsulates a fresh key share against the
      writer's `#atproto_kem` key, and verifies the `atproto-space-mac` the host answers with.
      Without the request, the host refuses with `BadSpaceMac`. The spec before this
      verification missed this.
    - `com.atproto.space.getBlob` needs no MAC. It serves only a blob that a record in that
      repo in that space references.
  - **What it fixes.** It removes the trust gap in Phase B: Antiphony reads what a member was
    authorized to read, and checks it as §3 and §4.1 do. It also lets Antiphony recheck a
    private record for deletion (§8.1) while a credential lives.
  - **A space that restricts apps** (`allowedApps` on a member-list policy) also wants a
    `clientAttestation`: a 60 s, single-use `private_key_jwt` from the tenant's OAuth client.
    The tenant passes it beside `delegationToken` when it has one.
  - **The tenant's OAuth session needs a space read scope** for the space type
    (`space:{type}?authority=*&skey=*&action=read`, in Grain's spelling). The member's PDS has
    to be able to resolve that space type's declaration, or the login fails with
    `invalid_scope`. That's tenant work, Bardcast's first.

*Alternative (revised 2026-11-02):* the group admits Antiphony's own DID as a read-only
member, and Antiphony mints its own delegations. On the reference implementation this needs
**no PDS account**. A delegation token is checked against its issuer's `#atproto` key, read from
the DID document, so a service DID that publishes one can sign its own. The conformance run did
exactly that: a `did:plc` with no PDS was refused until the space admitted it, then got a
credential on every try and read a writer's blob. Antiphony would then need no one's session at
all, and its sweep could renew credentials on its own (§8.1). What it costs:
- Antiphony holds a `membership` record in every such group. Under the opensocial proposal a
  member is listed on the roster only once it writes its own `acceptance`, and acceptance
  doesn't gate access. So a service that never writes one would read without being listed.
  That is the proposal's text; no host has been checked. On the reference PDS the member list
  is published when a policy sets `publishMembers`.
- It holds standing read access to each such space, which is a larger trust footprint than a
  per-registration delegation.
- Each group host has to grant a non-person DID a role that can read the space. The proposal
  neither provides for that nor forbids it, and no host has been checked (open question 2).
- Antiphony needs its own service DID with an `#atproto` key.

Recommended as an **opt-in per space**, beside delegation rather than instead of it.

**D-4. Bytes are copied, not proxied.** Antiphony keeps its own copy of each blob, in R2 at
`blobs/{originAppId}/{cid}` as today. Processing reads it many times (denoise, trim,
transcribe, waveform, renditions), and playback has to work when the upstream PDS is slow or
down. hatk caches space blobs only in memory, under a bound. That suits images; it doesn't
suit audio, which is processed. The copy's lifetime is tied to the source record's (§8).

## 5. What Antiphony indexes (D-5)

**D-5. A new table, `remote_posts`, beside `posts`; not rows in `posts`.** *Recommended.*

### 5.1 Why not `posts`

- `posts.id` is the rkey and the primary key. Two repos can hold the same rkey, so it can't
  key remote records.
- A hosted row's URI is computed (`authorityOf` / `postUriOf`). A remote row's URI is a fact
  read from somewhere else.
- `posts` carries the custody foreign keys from migration 0005, which a remote record must
  not need. A group's DID is never registered (#227).
- Keeping them apart means step 8 (retire hosting) can drop `posts` without touching remote
  posts.

### 5.2 Columns

| Column | From |
| :--- | :--- |
| `origin_app_id` | the caller; leads every index, as in `posts` |
| `uri`, `cid` | the registration, checked against the record (§3); PK `(origin_app_id, uri)` |
| `repo_did` | the DID whose repo holds the record: the URI's authority for a repo record, the author segment for a space record |
| `space` | `{ authority, type, skey }` when it's a space record, else null |
| `record` | the record as fetched (jsonb), validated against the lexicon |
| `blob_cid`, `mime_type`, `size` | the blob ref |
| `root_uri`, `parent_uri` (and CIDs) | the record's `reply` StrongRefs |
| `processing`, `lease_until` | as on `posts`; the same state machine |
| `verified` | `fetched` (§4.1, Phase C) or `pushed` (Phase B) |
| `checked_at`, `gone_at` | the deletion sweep (§8) |

### 5.3 Reads

- `GET /api/v1/remote-posts?uri=` returns one post.
- `GET /api/v1/remote-posts/thread?root=` returns a thread: rows with that `root_uri`, in the
  existing thread order.
- **The view is a new `RemotePostView`.** It carries `uri`, `cid`, the record, and the same
  embed a hosted post gets: `processing`, the transcript, waveform peaks and the playback
  URL. It reuses those schemas.
- **Why not `AudioPostView` with fields made optional:** it requires `id` (the hosted
  post's rkey) and the `authorId` facet, which a remote post doesn't have. Making them
  optional would be a typing break for clients that read them from hosted posts. A remote
  post's author is its repo DID (for a space record, the author segment).
- **A thread is only what was registered.** Antiphony doesn't crawl. If a reply wasn't
  registered, it isn't in the thread. That's correct for a service that processes what it's
  given, and Bardcast and Vox Pop register everything they write.
- **Hosted and remote don't mix in one thread.** A remote reply whose root is a hosted post
  is indexed by the hosted post's URI, so it reads back through the remote routes. The hosted
  thread route doesn't show it. Mixing them can wait until something needs it.

## 6. The enrichment pipeline, signed playback, webhooks

- **Processing is unchanged in substance.** The four stages, their ordering, the provider
  seam, durable dispatch and the lease are kept
  ([`enrichment-pipeline.md`](./enrichment-pipeline.md)).
  - What changes is the **subject key**. `AudioProcessingService` and its dependencies take
    a post id today. They take a subject (`{ kind: 'hosted', postId }` or
    `{ kind: 'remote', uri }`) and route to the matching table.
  - The queue message carries the subject.
  - The `processing` opt-in comes on registration (and on a `PATCH` equivalent), as on
    create.
- **Transcripts need a tenant column.** A remote post's transcript has the remote URI and
  CID as its subject, but `audio_transcripts` has no `origin_app_id`, and its unique index is
  on `subject_uri` alone (`0001_initial_schema.sql`). Two tenants that register the same URI
  (D-1 allows it) would overwrite each other's transcript, and deleting one tenant's copy
  would delete the other's. Hosted posts never hit this, because their URIs differ by
  authority. The fix, in two migrations so the deploy stays expand-then-contract:
  1. **Expand (with Phase A):** add `origin_app_id`, backfilled from `posts` (a hosted
     subject URI ends in the post's rkey, which is `posts.id` and globally unique), then set
     `not null` and add a unique index on `(origin_app_id, subject_uri)`. The code switches
     `saveTranscript` to `on conflict (origin_app_id, subject_uri)`, and every read and delete
     filters by tenant.
  2. **Contract (the following deploy):** drop `transcripts_subject_uri_key`. It can't go in
     the first migration, because the Worker still serving during the deploy upserts with
     `on conflict (subject_uri)`, which needs that index.

  Until the old index is dropped, a second tenant registering a URI another tenant already
  holds a transcript for fails on that index, so the contract migration must land before
  shared URIs are expected. Refusing a second tenant outright would also work, but its 409
  would tell one tenant that another registered the post.
- **Signed playback.** Exactly as for a post in a space today: a signed, expiring
  `/api/v1/audio` URL, minted when a view is hydrated or by `getPlaybackUrl`. The tenant
  makes the access decision first, as the managing app does today.
  - Antiphony doesn't check group membership. It can't, and the tenant already does. The
    tenant is trusted with the audio already, since it read the space to push it (Phase B)
    or delegated a member's read (Phase C).
  - A public record's blob gets a stable, unsigned URL, as flat posts have today.
- **Webhooks** ([`enrichment-webhooks.md`](./enrichment-webhooks.md)). The same events fire
  at the same points.
  - Payloads gain `uri` on every event, hosted and remote (additive). `postId` stays on
    hosted events and is absent on remote ones, for the reason in §5.1.
  - New lifecycle events tell the tenant what the deletion sweep did: `remote.gone` (source
    record deleted, Antiphony's copy removed) and `remote.changed` (source record edited;
    see §8.2).

## 7. Visibility of a remote blob

Today one CID is one R2 object per tenant, with one visibility, decided by its first upload
([`spaces.md`](./spaces.md), open question 3). For remote posts the records that reference
the blob decide it:

- **Private** while every registered record referencing it is a space record. Its playback
  URLs are signed only.
- **Public** as soon as a **verified** public record references it: a hosted flat post, or a
  public remote post Antiphony fetched itself (Phase A). Those bytes are already public in
  that repo through `com.atproto.sync.getBlob`, so keeping Antiphony's copy private would
  protect nothing.
- **Private to public happens only on a verified public reference**, never on a record the
  tenant pushed (Phase B). Otherwise a pushed record could expose a private blob.
- **Public never turns private.** Hosted flat posts have had stable, unsigned URLs since
  0.5.0, and a blob that stopped being public would break them. It would also protect
  nothing: some public record already has the bytes.
- **The derived variants follow the original.** Processing copies the original's marking
  onto the denoised and trimmed variants and the renditions, so a private-to-public change
  rewrites the metadata on each object listed in `derivedBlobCids` as well, in the same step.
- This differs from hosted posts, which refuse a mismatch. A tenant can refuse its own hosted
  writes; it can't refuse what a member already put in their own repo.

The marking stays in R2 custom metadata (`antiphony-space`, `antiphony-space-authority`). A
remote space's authority is a group DID that isn't in `tenant_dids`, which is fine because R2
metadata carries no foreign keys. Changing it means copying the object onto itself with new
metadata. The path and CID don't change.

## 8. Deletion and edits (D-6)

G3 is the rule: **a member's record is theirs, so if they delete it, it goes.** Antiphony's
copy and everything derived from it must go too, within a stated bound.

### 8.1 Noticing

**D-6. The tenant tells Antiphony first, and a sweep guarantees it.** *Recommended.*

- `DELETE /api/v1/remote-posts?uri=` removes it at once, and is idempotent. The tenant
  usually knows first: it made the delete, or it saw it in its own sync.
- **A sweep backs that up**, hourly in the existing cron, bounded like the registered-DID
  sweep (#229). It rechecks rows whose `checked_at` is oldest:
  - **Public:** `com.atproto.repo.getRecord` on the record's PDS.
  - **Space (Phase C):** a signed `com.atproto.space.getRecord`, with its MAC, while a
    credential is held. **A credential lives 10 minutes and can't be renewed without a fresh
    delegation** (verified 2026-11-02). So the hourly sweep can't hold one between runs. One
    credential covers a whole space, though: every writer's repo in it, signed per audience.
    So one delegation per space buys a recheck of every registered record in that space. A
    sweep gets that delegation one of two ways:
    - **The tenant supplies it** (recommended default). Antiphony asks per space, with a
      `remote.recheck_requested` webhook carrying the space URI. The tenant answers with
      `POST /api/v1/remote-posts/recheck { space, delegationToken, clientAttestation? }`,
      using any member session it holds. Antiphony spends the token at once and rechecks that
      space's rows within the credential's life. A tenant can also call `recheck` on its own
      schedule. A space whose rechecks go unanswered keeps its rows and is reported, as an
      unreachable repo is.
    - **Antiphony delegates as itself**, where a space admits Antiphony's service DID
      (§4.2's alternative). Then the sweep needs nothing from the tenant.
  - **Space, before Phase C, or a space row whose tenant never supplies a delegation:**
    Antiphony can't read the record, so the tenant's `DELETE` is the only signal. Phase B's
    registration says so, and a tenant that can't commit to sending it shouldn't use Phase B
    for member records.
- **Gone vs unreachable** follows the pin validator:
  - **gone** is `RecordNotFound` (for a space record, read with a valid credential), a
    tombstoned or deactivated DID, or `SpaceDeleted` from `getSpaceCredential`. The reference
    host answers `SpaceDeleted` for a deleted space with or without a delegation;
  - **not gone: `SpaceNotFound` from `getSpaceCredential`.** The reference host gives that
    same answer to a delegation from someone who isn't, or is no longer, a member, so that a
    refusal says nothing about the space. It means "this delegation can't read it", never "the
    space is gone". The recheck waits for another delegation;
  - anything else is **unreachable**.
  
  A row is removed only after it reads **gone** on two sweeps at least an hour apart, or at
  once on the tenant's `DELETE`. An unreachable PDS never deletes anything. If a PDS stays
  unreachable for 30 days, the row is kept but stops being served (the view says
  `unavailable`), and it is reported.
- **Revocation lags by up to a credential's life.** A credential issued before a member's
  removal kept reading the writer's blob afterwards in the conformance run. Hosts can cut it
  short with `notifyCredentialRevoked`. A Phase C read is therefore as fresh as the 10 minutes
  before it. That's the same order as signed playback's hour, and fine for a deletion sweep.
- **Later: notifications instead of polling.** For public records, a Jetstream subscription
  filtered to `dev.antiphony.audio.post` and the repo DIDs in the index. For spaces,
  `registerNotify` with the authority (hatk `notify.ts`). On the reference host it needs a
  credential and a `service` DID with a resolvable endpoint, and a registration lasts a day,
  so Antiphony needs a service DID for it as well. A `notifyWrite` carries no records: it says
  when to ask for a delegation, not what changed. Both kinds of notification are best-effort,
  so the sweep stays as the guarantee (hatk's "nothing here may be load-bearing").

### 8.2 Removing, and edits

- **Removal reuses the deletion machinery** ([`deletion.md`](./deletion.md)):
  - the row and its transcript go in one transaction;
  - the content-free ledger records the URI;
  - blob deletion is queued and drained by the existing cron. A blob still referenced by
    another row, hosted or remote, stays (§6.2 there).
  
  Replies registered under a deleted remote post are their own records in their own repos, so
  they stay. Their `parent_uri` dangles, as Bardcast's action log does (decision record open
  question 4).
- **Edits.** A record re-read with a different CID is an edit.
  - If the blob ref is unchanged, update the row and fire `remote.changed`. Nothing is
    reprocessed.
  - If the blob changed, treat it as a new blob: fetch, verify, reprocess. The old blob goes
    if nothing else references it.
  - A StrongRef that sealed the old CID now points at a version Antiphony no longer holds.
    The thread reads it by URI and shows the current version, as atproto apps generally do.

## 9. Derived records (decision record, open question 3) (D-7)

**D-7. Phase A–C: derived data lives only in Antiphony's index.** *Recommended.* Transcripts,
waveform peaks and processing state are served in views and announced by webhooks, as today.
The transcript keeps its lexicon shape (`dev.antiphony.audio.transcript`, with a StrongRef
`subject`), so it can be published later without a migration.

Why not publish them now:

- **In the same space, under Antiphony's DID.** Antiphony would need its own account on a
  spaces-capable PDS, and write access to every group's space. That's the admission problem
  in D-3's alternative. A transcript of private audio must not leave the space, so this is
  the only correct place for a private one. It waits on group hosts accepting service
  writers.
- **In Antiphony's own public repo.** Only for public subjects, and only if a consumer
  outside the tenant wants them (the labeler pattern). Nothing asks for that yet.
- **In the author's or the group's repo, written by the tenant.** Possible today, since the
  tenant holds those sessions and webhooks tell it when a transcript is ready. That's the
  tenant's product choice and needs nothing from Antiphony.

## 10. Coexisting with hosted posts

- **Nothing about hosted posts changes:** `POST /api/v1/posts`, `posts`, URIs Antiphony
  mints, custody pinning, `/api/v1/dids` and `authority`. Two parallel record sources share
  one pipeline, one blob store, one playback signer and one webhook sender.
- **Who uses which:**
  - Vox Pop personal prompts and their replies stay hosted, under Vox Pop's DID.
  - An org prompt under a group's DID is remote.
  - Bardcast's campaign posts move to remote as each table becomes a group.
  - Anything already kept stays where it is: nothing moves between the two.
- **Retiring hosting** (step 8) becomes deleting the hosted half once no tenant writes there.
  That's why D-5 keeps the tables apart.
- **A constraint outside Antiphony (open question 1).** A member's record in a group space
  must be in the member's own repo, and their PDS can only hold it if it serves spaces. Grain
  offers groups only to spaces-capable accounts for this reason. Players on a PDS without
  spaces (bsky.social today) can't write into a group space at all, and Antiphony can't host
  it for them, since the record's repo is resolved from their DID. Until their PDS supports
  spaces, Bardcast must either keep those players' recordings outside the group (a hosted
  space under Bardcast's DID, as today) or not offer group play to them. Decision record G6's
  "hosted for them until their PDS can hold spaces" doesn't work for records in a group's
  space. That's Bardcast's call, and it should be made before the first table becomes a
  group.

## 11. Contract changes (all additive; built as the 0.10.4 patch)

| Change | Where |
| :--- | :--- |
| `PUT /api/v1/remote-posts`, `GET ?uri=`, `GET /thread?root=`, `DELETE ?uri=`; `PATCH ?uri=` for `processing` | new routes, `RemotePost*` schemas in `@antiphony/shared` |
| `dev.antiphony.audio.registerPost` (XRPC) | new lexicon. Published lexicons can't take breaking changes, so this one waits until the REST shape has settled in use (see `xrpc-surface.md`). |
| `remoteSpace` on `POST /api/v1/audio/upload` | Phase B |
| `delegationToken` (and `clientAttestation`) on registration | Phase C, built as 0.10.6 |
| `POST /api/v1/remote-posts/recheck`; `remote.recheck_requested`; `deletionCheck: "recheck"` | Phase C, built as 0.10.6 (§8.1's revision) |
| `uri` on every webhook payload; `remote.gone` and `remote.changed` events | `enrichment-webhooks.md` |
| `RemotePostView` | new schema, sharing the record and embed schemas. `AudioPostView` is unchanged (§5.3) |

Nothing seals a URI. Antiphony stores URIs other people minted.

## 12. Dependencies

- **Phases A and B need no new dependency.** DID resolution exists (`lib/app-did.ts`), CIDs
  exist (`lib/cid.ts`), and `getRecord` / `getBlob` are plain XRPC GETs. Recomputing a
  record's CID is `cidForRecord` (`lib/cid.ts`, `@ipld/dag-cbor`), already used for
  Antiphony's own records.
- **Phase C needs `@atproto/space`**, for:
  - `getSpaceCredential`'s key binding and HTTP message signatures (`createSpaceSigHeaders`);
  - the record MAC: `encapsulate`, `formatWantMacHeader`, `parseMacHeader` and
    `verifyRecordMac`, using the header names `WANT_MAC_HEADER` and `MAC_HEADER`.

  [`spaces.md`](./spaces.md) ("Update 2026-10-07") recorded what adding it takes. Checked again
  2026-11-02:
  - **Pin `0.0.0-spaces-alpha-20261029171913` exactly.** It is still the newest alpha of
    `@atproto/space` and `@atproto/pds`. It renamed the management methods
    (`com.atproto.simplespace.*` became `com.atproto.space.createSpace` and
    `com.atproto.memberspace.*`). Phase C only uses `getDelegationToken`,
    `getSpaceCredential`, `getRecord` and `getBlob`, which are `com.atproto.space.*` in both.
    hatk pins the older `20261022141228`.
  - **Root `overrides`** for `@atproto/lex-data`, `lex-cbor`, `car`, `crypto`, `common` and
    `syntax` at the same alpha. These six are enough for `@atproto/space` alone: a clean
    install with them resolved in 5 s. Anything that pulls in the wider alpha tree (the
    reference PDS, `@atproto/dev-env`) dies mid-resolve on the `0.0.0` trap unless every
    `@atproto/*` package in it is overridden. Three of them (`jwk`, `jwk-jose`, `ws-client`)
    have no alpha. That only matters for a test harness, never for core-api.
  - **`nodejs_compat`**, which core-api has.
  - **zod 3 bundled beside zod 4**: the alpha still depends on `zod ^3.23.8`. Never pass a
    schema across the boundary.
  - **Workers probe rerun 2026-11-02** at this pin, under core-api's settings
    (`compatibility_date` 2025-11-01, `nodejs_compat`), in `wrangler dev`. All of these passed:
    - a delegation (60 s) and a credential (600 s, `cnf.kid` set) minted and verified;
    - a request signed, verified against its key, and refused against another key;
    - the record MAC: encapsulation, the host's decapsulation, and the MAC verified;
    - a space URI with a DID `skey` round-tripped through `AtUri.makeSpace`.
  - **KEM keys in DID documents.** PLC publishes `#atproto_kem` the legacy way
    (`EcdsaSecp256r1VerificationKey2019`, with a raw multibase key). Prefixing it with
    `did:key:` fails, so convert it as `@atproto/identity`'s `getDidKeyFromMultibase` does.
    Antiphony's DID resolver (`lib/app-did.ts`) has to learn the same conversion, without
    taking `@atproto/identity` as a dependency.
  - `@atproto/syntax` is already at an exact alpha in core-api and `packages/core`. It moves
    with it, to one version.
- **Not needed:** `@atproto/repo` to verify commit signatures on public records. Checking the
  CID against a record fetched from the DID's own PDS proves content and location; signature
  verification would add custody. Worth adding if a tenant ever registers a URI it didn't
  write. Neither app does.

## 13. Phases

| Phase | Ships | Unblocks |
| :--- | :--- | :--- |
| **A** *(built, 0.10.4)* | `remote_posts`; the transcript tenant column (§6); register, read, thread and delete for **public** records; Antiphony fetches (§4.1); processing, transcripts, playback and webhooks keyed by subject (§6); the deletion sweep for public records (§8) | Vox Pop org prompts under an org group's DID |
| **B** *(built, 0.10.5)* | Space records with **tenant-pushed bytes** (§4.2); `remoteSpace` on upload; visibility by reference (§7) | Bardcast campaign posts and Vox Pop org reply spaces on a group host |
| **C** *(built, 0.10.6)* | **Delegation hand-off**: Antiphony reads spaces itself, with the record MAC; the sweep covers space records through tenant-supplied (or, opt-in, Antiphony's own) delegations; `@atproto/space` added | Removes Phase B's trust gap and its reliance on the tenant for deletion |
| **D** | Notifications (Jetstream, `registerNotify`) to make the sweep rarely needed | Latency of deletion |
| **E** | Publishing derived records, once D-7 is revisited | Third-party readers of transcripts |

A and B can ship as one change if Bardcast needs B first. A is still worth landing on its own,
because it exercises the subject-key refactor (§6) on the simpler case.

## Phase A as built (2026-11-02, contract 0.10.4)

Where the build differs from the sections above, or settles what they left open:

- **Contract 0.10.4, a patch, not the 0.11.0 §11 named.** New routes and an added webhook field
  are additive, and `specs/api-versioning.md` makes additive changes a patch before 1.0.
- **Migration `0006_remote_posts.sql`.** It creates:
  - `remote_posts`, keyed `(origin_app_id, uri)`;
  - `deleted_remote_posts`, the ledger behind the 410;
  - the transcript tenant column (§6, the expand half), with its unique index.
  
  §5.2's `space` and `verified` columns wait for Phase B. The old unique index on
  `audio_transcripts.subject_uri` went in the next deploy
  (`0007_transcripts_drop_subject_index.sql`), so two tenants can each hold a transcript of the
  same remote URI.
- **Record CIDs.** A record from a PDS is hashed in its IPLD form, with `$link` as a CID link and
  `$bytes` as bytes (`cidForRepoRecord`, checked against Bluesky's data-model interop vectors).
  Both the CID the repo reports and the CID the tenant registers must match it.
- **The blob.** Its type is sniffed from its leading bytes: mp4, webm, ogg, wav and mp3, the
  types upload accepts. Size is capped at upload's 25 MB, enforced while reading. If the tenant
  already stores the bytes, nothing is downloaded, which makes "upload, then publish" cheap.
- **Bytes stored as private** (a hosted post in a space with the same audio) are refused with 409
  `REMOTE_BLOB_PRIVATE`, rather than turned public. Turning them public is §7's rule, which ships
  with Phase B.
- **Routes:** `PUT`, `GET`, `PATCH` and `DELETE /api/v1/remote-posts` (`?uri=` on all but `PUT`),
  and `GET /api/v1/remote-posts/thread?root=`. They are tenant-level (service token), like
  `/dids`: a remote post has no author facet to check.
- **Processing.** `AudioProcessingService` asks its deps for the post's subject: the URI, plus
  `postId` for a hosted post. The queue job is either `{ postId }` or `{ remoteUri }`. A remote job
  skips the app-DID custody proof, because it builds no URI under the app DID.
- **The sweep** runs hourly over 200 rows, least recently checked first:
  - a record found gone is removed on the next check at least an hour later;
  - an edit is taken: new audio re-requests every stage that had been requested, and the old
    blob goes to the drain;
  - an edit that leaves no acceptable audio post removes the registration as gone.
  
  The blob drain counts a remote post's blob and variants as references, so deleting a hosted
  post never removes audio a remote post uses.
- **Not built in Phase A:**
  - an XRPC `registerPost` (§11 keeps it until the REST shape settles);
  - Phase B (space records, tenant-pushed bytes, visibility by reference);
  - Phase C;
  - notifications in place of polling.

## Phase B as built (2026-11-02, contract 0.10.5)

Where the build differs from the sections above, or settles what they left open:

- **Contract 0.10.5, a patch.** New optional request fields, new view fields, and a refusal
  that no longer happens. The `@antiphony/shared` release waits for Phase C, so the schemas ship in one bump.
- **Migration `0008_remote_space_records.sql`** adds §5.2's `space` (jsonb,
  `{authority, type, skey}`) and `verified` (`fetched` | `pushed`). Checks: a pushed row is
  always a space row, and a space names a DID authority, a type and a key. `repo_did` is the
  author segment for a space record. The sweep's index now covers fetched rows only.
- **Upload.** `remoteSpace` (`at://{authority}/space/{type}/{skey}`) marks the blob with that
  space and its authority. It can't be sent beside `spaceType` / `skey` / `spaceAuthority`.
  It is refused for a space under the app DID or a DID the tenant registered: those spaces are
  hosted here and are named the hosted way. Without that rule, a "remote" upload could make a
  marking that matches a hosted space without the space existing. First upload still wins.
- **Registration of a space record.**
  - It takes `record` and `bytesFrom: "upload"`, which is the default for a space URI.
    `bytesFrom: "fetch"` on a space URI is 400 `REMOTE_URI_UNSUPPORTED` until Phase C.
    `record` is refused for a repo record, which Antiphony reads itself (400
    `REMOTE_REQUEST_INVALID`).
  - The body must hash to `cid` with `cidForRepoRecord`. A mismatch is 422
    `REMOTE_RECORD_INVALID`, not 409 `REMOTE_CID_MISMATCH`: here the tenant sent both, so it
    is a bad request, not a record that changed since it was read.
  - The blob must be this tenant's upload (422 if not), marked for exactly this space,
    authority included (409 `REMOTE_BLOB_SPACE_MISMATCH` otherwise).
  - One case §4.2 didn't name: **bytes stored public**. These are accepted only if a verified
    public record already references them. They are public anyway then (§7), and refusing
    would make the outcome depend on which record was registered first. Bytes that are public
    only because they were uploaded without `remoteSpace` are refused. Accepting them would
    give a space record's audio a stable, unsigned URL that anyone holding the CID could play.
  - Body limit for `PUT` is 64 KB (was 8 KB), to fit a pushed record's text and waveform.
- **The view** gains `space`, `verified` and `deletionCheck` (`sweep` | `tenant`).
  `deletionCheck: "tenant"` is how the registration response says §8.1's rule: Antiphony
  can't see the record deleted, so the tenant's `DELETE` is the only signal. The route docs
  for `PUT` and `DELETE` say the same.
- **Playback.** A space row always plays from signed URLs (`blob_private` is true on it),
  even when its bytes later turn public through another record.
- **Visibility by reference (§7)** replaces Phase A's 409 `REMOTE_BLOB_PRIVATE`:
  - A fetched public record whose bytes are stored private turns them public.
  - **Antiphony first downloads the blob from the record's repo and checks it hashes to the
    ref**, even with `bytesFrom: "upload"`. A public record that names a CID proves nothing
    about the bytes until its repo serves them. Without this check, anyone able to write a
    public record could name a private blob's CID and have the tenant expose it. If the repo
    doesn't serve the bytes, the registration is 422 and nothing changes.
  - `makeBlobPublic` rewrites the marking on the original and on every `processedBlobCid` and
    `derivedBlobCids` entry of any of the tenant's posts (hosted or remote) with that original.
    R2 can't edit metadata in place, so each object is read and written back to its own path.
    Variants go first and the original last, so a failure part-way leaves the original private
    and a retry redoes it.
  - A pushed record never turns anything public, and nothing turns private. Hosted posts still
    refuse a mismatch.
  - **Known race.** A processing pass that started before the change and writes a variant
    after it marks that variant private. A public view of it then points at an unsigned URL
    the proxy refuses, until the variant is reprocessed. This is rare (it needs a public
    registration during the pass) and doesn't leak anything.
- **Derived variants carry the authority.** Processing used to mark a variant with the post's
  `{type, skey}` only, so a variant of audio in a space under a registered DID or a group's
  space lost the authority. It now passes the post's authority too. A remote space row
  presents its space and authority to the pipeline for this.
- **Open question 3: tenant scoping, as recommended.** No proof that the tenant acts for the
  space's authority. The custody check `tenant_dids` uses can't apply, since a group's DID
  names its group host, not Antiphony (#227). Checking a group session would need Phase C's
  credential exchange. A made-up registration stays in the tenant's own index, uses its own
  upload, and can't make a blob public. Phase C can revisit pushed rows (promote each to
  `fetched`, or remove it).
- **Not built in Phase B:** Phase C (delegation hand-off, the sweep for space records,
  `@atproto/space`), the XRPC `registerPost`, and notifications.

## Phase C verification (2026-11-02)

Stage 1 of Phase C: checking its assumptions before any product code. There are four sources.
The first three are in order of strength; the fourth is the proposal itself, read afterwards.

1. **A conformance run of the reference implementation at the pin.** `@atproto/dev-env`
   `0.0.0-spaces-alpha-20261029171913` ran in-process: one PLC and two PDS hosts, with the
   reference PDS's own handlers.
   - Host A holds a group, the space's authority, with a member-list space
     (`game.bardcast.space.campaign/thornwood`).
   - Host B holds a player, who is a member, and an outsider.
   - "Antiphony" is a script holding no session, only a key it generated.

   This is the conformance harness of `cross-repo-design.md` §4.3 step 4 without containers.
   Docker was available but its VM (colima) was stopped, and dev-env made it unnecessary.
   **25 of 25 checks passed:**

   | Check | Result |
   | :--- | :--- |
   | Member's PDS mints a delegation (session auth) | 200 |
   | **(a)** Authority issues a credential for it, bound to Antiphony's own key | 200 |
   | The same delegation again | 400 `InvalidDelegationToken` (single use) |
   | An outsider's delegation | 400 `SpaceNotFound` |
   | No delegation, non-public space | 400 `SpaceNotFound` |
   | Writer's DID document has `#atproto_kem` | yes, in the legacy key form (§12) |
   | Signed `getRecord` on the **writer's** host, without a MAC request | 400 `BadSpaceMac` |
   | The same with a MAC request: record returned, MAC verified | 200 |
   | The record hashes to the CID the host reports (`$link` blob refs) | yes, so §3's check carries over |
   | A signature for the wrong audience | 401 `BadSpaceAudience` |
   | **(c)** `getBlob` on the writer's host, with the authority's credential | 200 |
   | `getBlob` for a blob no space record references | 400 `BlobNotFound` |
   | **(b)** A service DID with no PDS, not yet admitted, delegating as itself | 400 `SpaceNotFound` |
   | **(b)** Admitted as a read-only member: two self-minted delegations | 200, 200 |
   | **(b)** That credential reads the writer's blob | 200 |
   | A credential issued before the member's removal, used after it | 200 (lags until expiry) |
   | The removed member's new delegation | 400 `SpaceNotFound` (same as a missing space) |
   | Record deleted, read with a valid credential | 400 `RecordNotFound` |
   | Space deleted, credential asked for | 400 `SpaceDeleted` |

2. **The reference PDS's source** at the pin (`getSpaceCredential`, `getDelegationToken`,
   `getRecord`, `getBlob`, `registerNotify`, the auth verifier, the space policy manager) and
   `@atproto/space` (`credential.js`, `kem.js`, `mac.js`). These give the reasons behind the
   results:
   - token lifetimes: delegation 60 s and single use, credential 600 s with a 3600 s cap;
   - a member-list policy admits any member with read, and its `allowedApps` gates on a
     verified client attestation;
   - a managed space defers to its managing app's `checkUserAccess`, which denies when the app
     can't be reached;
   - a refused user is answered `SpaceNotFound` on purpose.
3. **Grain and hatk** at the commits §2 cites (`0eb252c`, `2174631`; neither has moved).
   - hatk's `credential.ts` and `mac.ts` match the reference flow, and hatk already sends the
     MAC request on `getRecord`.
   - Grain reads opensocial group pools and checks membership through member delegations,
     against the opensocial host in its dev stack and in production.
   - Grain's `groups.test.ts` runs against a mocked server, so it shows Grain's assumptions,
     not the host's behaviour.

4. **The opensocial proposal and the atproto team's posts about it.** The proposal's repo on
   tangled.org still answers 502. Brad supplied a copy on 2026-11-02, and it matches the
   definition quoted in the atproto blog's
   [introduction to atmospheric groups](https://atproto.com/blog/atmospheric-groups-intro).
   Its companion post is [the open social groups vision](https://atproto.com/blog/open-social-groups-vision).
   What they settle:
   - **An opensocial host is not the reference PDS's member-list policy.** It is a peer of the
     reference policies, with its own authorization:
     - flat role-based access, where a member's actions are the union of their roles';
     - an `access` record in each space naming the roles that may read it;
     - read access enforced by the host **when it issues space credentials**, per the intro
       post.

     The wire is the same Spaces protocol (`com.atproto.space.*`). So the exchange, the
     signatures, the MAC and `getBlob` above apply. What decides who gets a credential is the
     host's roles, not a member list.
   - **Writer sets are as Phase C assumes.** The intro post walks through Grain reading a
     group space: Grain asks the group's host which repos are in the space, then reads each one
     from its own PDS. The host tracks the repos and routes notifications, but doesn't hold
     members' records. That is (c) in the protocol's own account.
   - **Each app gets its own modality space under the group DID.** Bardcast's campaign space is
     one, created through the host's `createSpace`, listed in the group's space index, and
     given an `access` record. The tenant needs a role that allows `space.create` for that. The
     two well-known spaces, `meta` and `members`, are for records about the group, not app data.
   - **A third way to delegate.** The group host is also an OAuth authorization server for the
     group DID: an admin signs in with their own account and acts as the group within their
     roles. On the reference PDS the authority can always read its own spaces, so a tenant
     holding such a session could mint delegations as the group itself. That doesn't depend on
     any one member staying in the group. On an opensocial host this is unverified.
   - **There's a live host.** `opensocial.fyi` is the atproto team's prototype host, and
     `bsky.network` offers spaces-enabled accounts. A conformance run against them is possible.
     It needs test accounts that Brad would create (Claude can't create accounts), and a group
     that admits them.
   - **Churn.** The vision post says Spaces still gets breaking changes weekly. The pin
     discipline in §12 matters more, not less.
   - **Namespaces.** The proposal names everything `group.opensocial.*`, while the live host
     and Grain use `fyi.opensocial.*` (the intro post calls it an early revision). Phase C names
     neither: it only reads modality spaces through `com.atproto.space.*`.

**What it can't show.** How an opensocial host maps roles to credentials in practice, and
whether it grants one to a service DID or to the group DID's own delegation. Its code is still
unreachable, and the conformance run used the reference PDS. Grain's production use is the
evidence that member delegations work. A managed space, where a host defers to a managing app,
behaves differently again: there the app's `checkUserAccess` answers for Antiphony too.

**Recommendation: go for Phase C**, built against the reference behaviour. These are the
changes from the design above:

1. **The record MAC on every space `getRecord`**, with KEM keys read from DID documents in
   both key forms (§12).
2. **`clientAttestation`, optional, beside `delegationToken`** on registration and on recheck,
   for spaces that restrict apps.
3. **The sweep for space rows runs on delegations**, never on a held credential (§8.1):
   - by default, a `remote.recheck_requested` webhook per space, answered by
     `POST /api/v1/remote-posts/recheck`;
   - opt-in, Antiphony's own service DID as a member with a reading role.

   The second needs a decision (§4.2's alternative) and a service DID. It can follow Phase C.
   A delegation as the group DID (source 4) needs nothing new from Antiphony, since the tenant
   mints it like any other. It's the tenant's best default where it holds an admin's group
   session.
4. **`SpaceNotFound` at the exchange is never "gone"**; `SpaceDeleted` and `RecordNotFound` are.
5. **Registration answers what the exchange says.** A refused delegation is a 403. It keeps the
   host's ambiguity and doesn't claim the space is missing. An unreachable host is a 503, as
   today.
6. **Phase B stays** for tenants that can't mint delegations (no space scope yet), and a pushed
   row upgrades to `fetched` on its first successful credentialed read.
7. **Rerun the conformance script against a real opensocial host** before the first group uses
   it: `opensocial.fyi`, with test accounts on `bsky.network`. The script is not in this repo
   yet; Phase C adds it as the harness.
8. **The delegating member must hold a role that reads that space**, not just belong to the
   group. A refusal reads `SpaceNotFound`, as above. The tenant picks the session; Antiphony
   only reports the refusal.

## Phase C as built (2026-11-02, contract 0.10.6)

Built as "Phase C verification" recommends. Where the build differs from the sections above, or
settles what they left open:

- **Contract 0.10.6, a patch.**
  - New optional request fields, a new route and a new webhook;
  - `recheck` added to `deletionCheck`, a response enum. That's additive under
    `specs/api-versioning.md`, though a client with an exhaustive switch has to add the case.

  `@antiphony/shared` 0.13.0 ships Phase B's and Phase C's schemas together.
- **Dependencies, as §12 says.**
  - `@atproto/space` and `@atproto/crypto` at `0.0.0-spaces-alpha-20261029171913`, exact, in
    core-api. `@atproto/crypto` is direct because the adapter makes the credential's P-256 key
    and converts KEM keys with it.
  - `@atproto/syntax` moved to the same alpha in core-api and `packages/core`.
  - Root `overrides` pin `lex-data`, `lex-cbor`, `car`, `crypto`, `common` and `syntax`.
    Overrides apply to the whole tree, so `@atproto/lex-schema`'s copies (under
    `lex-document`, the lexicon check) move to the alpha too. `test:lexicons` still passes.
  - zod 3 comes in under `@atproto/space` only, and no schema crosses into it.
  - The lockfile was written with npm 12.0.2 (the root `packageManager`). An older npm drops
    `libc` fields throughout it.
  - The Worker bundle grew from 1624 to 1976 KiB, and `check:worker-bundle` stays clean.
- **The adapter** (`adapters/outbound/atproto/space-repo.ts`) behind a new `SpaceRepoPort`:
  - one `getSpaceCredential` exchange per call, at the authority's `#atproto_pds`, with a
    fresh P-256 key that is never exported;
  - requests signed per writer, with `getRecord`'s record MAC encapsulated against the
    writer's `#atproto_kem`. Both key spellings are read (`did-document.ts`, shared with the
    public-repo adapter, which moved onto it);
  - the URI and the MAC are verified, then the record's CID is recomputed as for a repo
    record.

  Classification:
  - `SpaceDeleted` is `deleted`;
  - `SpaceNotFound`, the token errors and `AppNotAuthorized` are `refused`;
  - a writer's 401 is `unreachable`.

  Tested against a fake host built from `@atproto/space`'s own primitives. It was also run
  once, outside the suite, against the reference stack from "Phase C verification":
  exchange, MAC-checked record, blob, `gone`, `refused` and `deleted` all passed.
- **Registration.**
  - `delegationToken` makes `bytesFrom: "fetch"` the default for a space URI.
  - `record` beside a delegation, a delegation for a repo record, or an attestation without
    a delegation is 400 `REMOTE_REQUEST_INVALID`.
  - The bytes are stored private for the space. Bytes already stored follow the Phase B rule:
    marked for exactly that space, or public with a verified public reference.
  - A delegation for a row that was only pushed is not a repeat: it reads the row and makes
    it `fetched`.
  - Exchange answers map to 403 `REMOTE_DELEGATION_REFUSED`, 404 `REMOTE_RECORD_NOT_FOUND`
    (space deleted), 503 or 422.
- **Rechecks (§8.1).**
  - `POST /api/v1/remote-posts/recheck` spends one delegation on up to 100 of a space's rows
    not checked in the last ten minutes. It stops a minute before the credential expires and
    says `remaining`.
  - The hourly sweep reads repo records only (`space is null`, migration 0009's index). It
    sends `remote.recheck_requested` per space whose oldest check is over an hour old, **only
    for spaces holding a `fetched` row**: a tenant that only pushes isn't asked. Each request
    has its own event id, so an unanswered space is asked again hourly.
  - A space unanswered past 30 days is logged. Its rows are **not** marked unavailable, since
    a tenant that stops answering shouldn't make its own posts stop playing. That differs
    from an unreachable public repo, and open question 4 covers both.
  - A deleted space reads as gone for every row, under the same two-reads rule.
- **Not built:**
  - Antiphony's own service DID as a member (§4.2's alternative; it needs a decision and a DID);
  - `registerNotify` (Phase D);
  - acting on group moderation labels (open question 5);
  - the conformance harness in this repo. Its dependencies need overrides for the whole
    `@atproto` alpha tree, which don't belong in the workspace lockfile, so it ran from a
    scratch project. Adding it as a standalone project is a follow-up.

## 14. Open questions

1. **Players without spaces support** (§10). That's Bardcast's call, and it should be made
   before the first table becomes a group.
2. **The opensocial proposal.** **Answered 2026-11-02**, for the reference implementation by
   running it, and for an opensocial host by the proposal's text ("Phase C verification",
   sources 1 and 4). Its repo on tangled.org still answers 502; Brad supplied a copy, which
   the atproto blog's intro post corroborates.
   - **Credentials for a member's delegation:** yes, **if the member holds a role the space's
     `access` record names**. The proposal has the host enforce that at credential issuance.
     It's not every member. On the reference host, any member with read gets one. Grain's
     membership check against the opensocial host is this same exchange.
   - **A service admitted as a reader:** yes on the reference host, as a read-only member with
     no PDS account (§4.2's alternative). The proposal neither provides for it nor forbids it:
     it would be a `membership` with a reading role and no `acceptance`, so the service would
     stay off the roster. Unverified on a host.
   - **`getBlob` on a writer's PDS for a credential the authority's host issued:** yes. The
     writer's host checks the signature against the authority's `#atproto` key and the request
     signature against the bound key, and serves only blobs that a record in that space
     references. The intro post describes the same writer-set model.
   - **The sweep within a credential's life:** no. Credentials last 10 minutes and need a new
     delegation each time (§8.1's revision).

   Before Phase C ships to a group on a real opensocial host, rerun the conformance script
   against that host (`opensocial.fyi`). That is the one step the reference run and the
   proposal's text can't stand in for.
3. **Who may register a URI.** Any tenant may register any record it can name.
   - **Public records:** Antiphony fetches and checks the record itself, so a tenant learns
     nothing it couldn't fetch.
   - **Phase B proves nothing about access.** The tenant supplies the record body and the
     bytes, and Antiphony checks only that they match their CIDs. A tenant could register a
     record it never read, under a space it isn't in.
   - **What contains that is tenant scoping.** A made-up registration exists only in that
     tenant's index, views and webhooks. It can't reach another tenant, and it can't make a
     blob public (§7). So the only party it can mislead is the tenant that made it up.
   - **Phase C would add proof of access:** a delegation token shows a member of the space
     authorized the read.
   
   Is tenant scoping enough until then, or should a Phase B registration also show the
   tenant acts for the space's authority (for example, through a group session it holds)?

   **Settled for Phase B (Brad, 2026-11-02): tenant scoping is enough** ("Phase B as built").

   **Phase C (2026-11-02): a delegation proves access.** A record registered with a
   `delegationToken` was read on a credential the space's authority issued for a member who can
   read the space. So the tenant must hold that member's session, and the record is what the
   writer's host serves, checked by its MAC and CID.
   - What a delegation doesn't prove is that the tenant is an app the space wants. A space
     that cares lists `allowedApps`, and the tenant sends a `clientAttestation`.
   - Pushed registrations keep Phase B's answer. A pushed row becomes `fetched` once a recheck
     reads it on a delegation.
   - Neither kind can make a blob public (§7).
4. **Retention when a PDS stays unreachable** (§8.1: kept but not served after 30 days). Is
   30 days right, and should the row then be deleted rather than kept?
5. **Group moderation labels.** Under the proposal a group is a moderation service: it writes
   `label` records into the space its subject is in, including `!hide` and `!takedown`. Once
   Antiphony reads spaces (Phase C), should it honor a takedown on a registered record (stop
   serving it, or remove it), or leave that to the tenant? Not needed for Phase C. Decide
   before the first group moderates audio.
