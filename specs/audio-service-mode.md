# Audio-service mode: processing audio whose record lives elsewhere

**Status:** proposal, 2026-11-02. **Awaiting Brad's approval; nothing is built.** This is
step 6 of the work table in [`audio-service-and-groups.md`](./audio-service-and-groups.md)
(G2), which the 2026-11-02 finding there (#227) made the critical path: an opensocial group's
DID names its group host as its PDS, so Antiphony can't hold a group's records or members'
records in a group's spaces. It can only process and serve the audio those records point to.
This spec says how.

Every **D-n** below is a decision for review. Each gives a recommendation and the main
alternative. Nothing here seals a URI. Contract changes are additive and are listed in
§11.

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
    addressed to.
  - **Public spaces.** A space whose read policy is public gets a credential with no
    delegation (`mintPublicSpaceCredential`).
  - **Space blobs** (`blob.ts`). They are served only through an authorized proxy and never
    given a public URL, "since giving one a public URL would turn that URL into the
    capability the credential exists to replace". hatk checks the MIME type itself rather
    than trusting the writer's.
  - **Write notices** (`notify.ts`). `notifyWrite` is best-effort and carries no records.
    "Nothing here may be load-bearing": a reconcile sweep is what makes sync correct.
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
- **Phase C: delegation hand-off.** The tenant asks the member's PDS for a delegation token
  for the space (`com.atproto.space.getDelegationToken`) and passes it with the registration
  (`delegationToken`). The token is single-use and lives 60 s, so it's spent at once.
  Antiphony exchanges it at the authority's `getSpaceCredential` for a credential bound to
  **a key Antiphony generates and holds** for that credential's life. With it, Antiphony
  reads the record from the writer's PDS (`com.atproto.space.getRecord`) and the blob
  (`com.atproto.space.getBlob`), signing each request. This removes the trust gap in Phase B,
  and lets Antiphony recheck a private record for deletion (§8) while a credential lives.

*Alternative:* the group admits Antiphony's own DID (a `service` role, or `appAccess`), so
Antiphony mints credentials without anyone's delegation. That would put Antiphony in every
group's roster and needs an Antiphony account on a spaces-capable PDS. Revisit if group hosts
grow a notion of service readers. The proposal is unverified on this (open question 2 in the
decision record).

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
- **Transcripts.** `audio_transcripts` is keyed by `subject_uri` already. A remote post's
  transcript has the remote URI and CID as its subject. No schema change.
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

Today one CID has one visibility per tenant, decided by its first upload
([`spaces.md`](./spaces.md), open question 3). For remote posts the record decides, not the
upload:

- A blob referenced by any registered **space** record is private (signed playback only).
- A blob referenced only by public records is public.
- **The stricter one wins.** A blob already marked public turns private when a space record
  that references it is registered. Public to private is safe, since public URLs simply stop
  working. Private to public never happens implicitly.
- This differs from hosted posts, which refuse a mismatch. A tenant can refuse its own
  hosted writes; it can't refuse what a member already put in their own repo.

The mark stays in R2 custom metadata. A remote space's authority goes in the existing
`antiphony-space-authority` key. It names a group's DID that isn't in `tenant_dids`, which is
fine because R2 metadata carries no foreign keys.

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
  - **Space (Phase C):** `com.atproto.space.getRecord`, while a credential is held.
  - **Space, before Phase C:** Antiphony can't read the record, so the tenant's `DELETE` is
    the only signal. Phase B's registration says so, and a tenant that can't commit to
    sending it shouldn't use Phase B for member records.
- **Gone vs unreachable** follows the pin validator:
  - **gone** is `RecordNotFound`, a tombstoned or deactivated DID, or a space that has been
    deleted;
  - anything else is **unreachable**.
  
  A row is removed only after it reads **gone** on two sweeps at least an hour apart, or at
  once on the tenant's `DELETE`. An unreachable PDS never deletes anything. If a PDS stays
  unreachable for 30 days, the row is kept but stops being served (the view says
  `unavailable`), and it is reported.
- **Later: notifications instead of polling.** For public records, a Jetstream subscription
  filtered to `dev.antiphony.audio.post` and the repo DIDs in the index. For spaces,
  `registerNotify` with the authority (hatk `notify.ts`). Both are best-effort, so the sweep
  stays as the guarantee (hatk's "nothing here may be load-bearing").

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

## 11. Contract changes (all additive; a 0.11.0 minor)

| Change | Where |
| :--- | :--- |
| `PUT /api/v1/remote-posts`, `GET ?uri=`, `GET /thread?root=`, `DELETE ?uri=`; `PATCH ?uri=` for `processing` | new routes, `RemotePost*` schemas in `@antiphony/shared` |
| `dev.antiphony.audio.registerPost` (XRPC) | new lexicon. Published lexicons can't take breaking changes, so this one waits until the REST shape has settled in use (see `xrpc-surface.md`). |
| `remoteSpace` on `POST /api/v1/audio/upload` | Phase B |
| `delegationToken` on registration | Phase C |
| `uri` on every webhook payload; `remote.gone` and `remote.changed` events | `enrichment-webhooks.md` |
| `RemotePostView` | new schema, sharing the record and embed schemas. `AudioPostView` is unchanged (§5.3) |

Nothing seals a URI. Antiphony stores URIs other people minted.

## 12. Dependencies

- **Phases A and B need no new dependency.** DID resolution exists (`lib/app-did.ts`), CIDs
  exist (`lib/cid.ts`), and `getRecord` / `getBlob` are plain XRPC GETs. Recomputing a
  record's CID is `cidForRecord` (`lib/cid.ts`, `@ipld/dag-cbor`), already used for
  Antiphony's own records.
- **Phase C needs `@atproto/space`**, for `getSpaceCredential`'s key binding and HTTP message
  signatures (`createSpaceSigHeaders`). [`spaces.md`](./spaces.md) ("Update 2026-10-07")
  recorded what adding it takes, and that still holds:
  - **Pin an exact alpha.** Grain notes the reference alpha renamed the management methods
    at `0.0.0-spaces-alpha-20261029171913` (`com.atproto.simplespace.*` became
    `com.atproto.space.createSpace` and `com.atproto.memberspace.*`). Phase C only uses
    `getDelegationToken`, `getSpaceCredential`, `getRecord` and `getBlob`, under
    `com.atproto.space.*` in both, but pin a version at or after that one so the wire names
    match what hosts serve.
  - **Root `overrides`** for `@atproto/lex-data`, `lex-cbor`, `car`, `crypto`, `common` and
    `syntax` at the same alpha. Without them npm dies mid-resolve on the `0.0.0` trap.
  - **`nodejs_compat`**, which core-api has.
  - **zod 3 bundled beside zod 4.** Never pass a schema across the boundary.
  - **Re-run the Workers probe** (mint, sign, verify) at the chosen version before relying on
    it.
  - `@atproto/syntax` is already at an exact alpha in core-api and `packages/core`. It moves
    with it, to one version.
- **Not needed:** `@atproto/repo` to verify commit signatures on public records. Checking the
  CID against a record fetched from the DID's own PDS proves content and location; signature
  verification would add custody. Worth adding if a tenant ever registers a URI it didn't
  write. Neither app does.

## 13. Phases

| Phase | Ships | Unblocks |
| :--- | :--- | :--- |
| **A** | `remote_posts`; register, read, thread and delete for **public** records; Antiphony fetches (§4.1); processing, transcripts, playback and webhooks keyed by subject (§6); the deletion sweep for public records (§8) | Vox Pop org prompts under an org group's DID |
| **B** | Space records with **tenant-pushed bytes** (§4.2); `remoteSpace` on upload; stricter-wins visibility (§7) | Bardcast campaign posts and Vox Pop org reply spaces on a group host |
| **C** | **Delegation hand-off**: Antiphony reads spaces itself; the sweep covers space records; `@atproto/space` added | Removes Phase B's trust gap and its reliance on the tenant for deletion |
| **D** | Notifications (Jetstream, `registerNotify`) to make the sweep rarely needed | Latency of deletion |
| **E** | Publishing derived records, once D-7 is revisited | Third-party readers of transcripts |

A and B can ship as one change if Bardcast needs B first. A is still worth landing on its own,
because it exercises the subject-key refactor (§6) on the simpler case.

## 14. Open questions

1. **Players without spaces support** (§10). That's Bardcast's call, and it should be made
   before the first table becomes a group.
2. **The opensocial proposal**, still unreachable. Specifically:
   - whether a group host issues credentials for its spaces to a delegation from any admitted
     member (what Phase C assumes, and what hatk does);
   - whether a service can be admitted as a reader (D-3's alternative);
   - whether `getBlob` on a writer's PDS serves a blob to a credential the group's host
     issued.
   
   Verify against a running opensocial host before building Phase C. The conformance harness
   in `cross-repo-design.md` §4.3 step 4 is the place to do it.
3. **Who may register a URI.** Any tenant may register any record it can name. For public
   records that adds nothing anyone couldn't fetch. For space records it relies on Phase B's
   push or Phase C's delegation, both of which prove the tenant could read the record. Is
   that enough, or should a tenant also show it acts for the space's authority?
4. **Retention when a PDS stays unreachable** (§8.1: kept but not served after 30 days). Is
   30 days right, and should the row then be deleted rather than kept?
