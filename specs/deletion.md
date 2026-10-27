# Deleting posts and their audio

**Status:** implemented, API contract 0.10.0 (2026-10-27). Proposed 2026-10-20, and the
decision points in § 11 approved as recommended. Where the build differs from the
proposal, § 12 says so.

**Why now.** Vox Pop has promised listeners and creators that their recordings
can be erased, and Antiphony has no delete operation of any kind: no route
removes a post, a blob, a rendition or a transcript. Vox Pop's partner-readiness
plan (step 2.3, `bbthorson/vox-pop` `specs/drafts/partner-readiness.md`) waits on
this spec to decide what deletion means here. Its two recorded decisions shape
the design:

- **Decision 2.** When a creator's account is erased, listeners' replies go with
  the prompts, except a reply whose listener has linked an AT Protocol identity
  (the reply's `authorDid` facet). That reply is kept and loses its link to the
  prompt.
- **Decision 3.** Erasure happens on request only, within 30 days. Nothing is
  erased automatically.

**Companions:** [`spaces.md`](./spaces.md) (reply spaces, signed playback),
[`atproto-authority-model.md`](./atproto-authority-model.md) (facets, sealed
StrongRefs), [`service-auth.md`](./service-auth.md),
[`enrichment-webhooks.md`](./enrichment-webhooks.md),
[`api-versioning.md`](./api-versioning.md).

## Summary

- **Hard delete of everything with content in it, plus a deletion ledger with no
  content in it.** The post row, its transcript and every blob and rendition only
  it used are removed. A `deleted_posts` row keeps the post's URI and deletion
  time, which is what makes a repeated delete idempotent and what a future sync
  surface would emit as a delete op.
- **This is atproto's own model.** A repo does not keep per-record tombstones: a
  deleted record is absent, and the commit that removed it records the delete.
  Antiphony has no commits yet (Phase 3), so the ledger stands in for that history.
- **The caller chooses what happens to the replies below a post:** delete them
  all (the default), keep them all, or keep only the ones with an `authorDid`.
  Kept replies keep their URI and CID, so their StrongRef to the deleted parent
  dangles. That is how decision 2's "loses its link" is expressed. Nothing is
  moved, because a reply's URI is sealed into every reply beneath it.
- **A blob is deleted only when no remaining post in the tenant references it.**
  Blob deletion goes through a queue table written in the same transaction as
  the post deletion, so a crash cannot leave bytes behind with nothing pointing
  at them.
- **Three routes:** delete one post, erase an author (paged, for account erasure),
  and delete an empty space. All take the service token; tenancy is the only
  thing Antiphony enforces. Who may delete is the tenant's decision.
- **Contract `0.10.0`** (minor), because a reply's parent StrongRef can now point
  at nothing and `GET /posts/{postId}` gains a `410`. `@antiphony/shared` gets new
  exports; releasing it is a separate decision.

## 1. What a post owns

Everything below is scoped to one tenant (`origin_app_id`). Blobs are stored at
`blobs/{originAppId}/{cid}`, so two tenants never share an object even when they
upload the same bytes. Sharing by CID happens only within a tenant.

| Data | Where | Deleted with the post? |
| :--- | :--- | :--- |
| The post record, its facets, its processing state | `posts` row | Yes |
| The original audio (`embed.audio.ref.$link`) | R2 `blobs/{app}/{cid}` | Yes, unless another post in the tenant references the CID |
| The processed variant (`processing.processedBlobCid`) | R2 `blobs/{app}/{cid}` | Same rule |
| Intermediate variants (denoise output that trim then replaced, or a variant a reprocess superseded) | R2 `blobs/{app}/{cid}` | Same rule, **once they are recorded** (§ 1.1) |
| Renditions of any of those (`mp3` today) | R2 `renditions/{app}/{cid}.{ext}` | Yes, with their source blob |
| Waveform peaks | `processing.waveformPeaks` in the row, `embed.waveform` in the record | Yes, with the row. They are not separate objects. |
| Transcript | `audio_transcripts`, keyed by the post's URI | Yes |
| Idempotency keys for its create | `idempotency_keys` | No. They hold the post id only and expire in 24 hours. |
| Space membership | nowhere | Nothing to delete: under `managing-app` the tenant holds membership, and Antiphony stores no member list. |
| The space itself | `spaces` row | No. A space is deleted explicitly, and only when empty (§ 4.3). |

### 1.1 Gap found while writing this: unrecorded variants

Processing writes a new content-addressed blob for each byte-mutating stage, but
the post only keeps the latest one (`processedBlobCid`). A post that ran denoise
then trim in one pass has the denoised blob in R2 and no field pointing at it.
The same happens when a reprocess replaces a variant. Those blobs hold the
person's voice, so an erasure that misses them is not an erasure.

**Fix, in this change:** processing records every derived CID it writes in a new
internal list on the processing state, `derivedBlobCids`, appended by the same
statement that settles the stage. Deletion considers the original CID,
`processedBlobCid`, and everything in `derivedBlobCids`. Like the other variant
fields, it is storage-only and never reaches a view.

**Not fixed by this change:** variants written before it ships, and uploads that
never became a post (a recording abandoned before `POST /posts`). Neither has a
row pointing at it. They need an orphan sweep: list `blobs/{app}/`, and delete
objects that no post references and that are older than a grace period. It is
listed under § 9. Vox Pop's privacy page should not promise that an abandoned
upload is erased until it exists.

## 2. Hard delete or tombstone

### 2.1 What atproto does

In an atproto repo, deleting a record removes it from the repo's tree. A later
`getRecord` answers `RecordNotFound`, exactly as for a record that never existed.
The deletion survives only as an operation in the commit that made it, which the
firehose carries so relays and AppViews can drop their copies. Account deletion
is an `#account` event with status `deleted`. Records that point at a deleted
record, such as replies, are not touched: their StrongRef dangles, and Bluesky's
AppView renders the missing parent as a "not found" placeholder.

So "atproto-style tombstone" does not mean a stub record holding the post's
place. It means the content is gone and the fact of the deletion is kept.

### 2.2 Decision

**Hard delete, plus a ledger.**

- The `posts` row, transcript and unreferenced blobs and renditions are deleted.
  No stub post remains and nothing about the content survives: no text, title,
  audio CID, record CID, author or facets.
- A `deleted_posts` row is written in the same transaction:
  `(origin_app_id, post_id, uri, kind, deleted_at)`. The URI is built the way
  hydration builds it, with the space segments when the post was in a space.
  None of those fields is personal: the URI's segments are the authority's DID,
  the collection, a space type, a space key (for Vox Pop, the prompt's rkey) and
  a TID.
- The ledger is kept indefinitely. It is what lets a repeated delete answer
  "already deleted" rather than 404, what lets `GET` tell a deleted post from a
  mistyped id, and, once Antiphony serves sync (Phase 3) or exports anything, the
  source of the delete ops that tell copies to go away.

Why not a stub record: a stub has to keep something to be useful (at minimum
the CID that StrongRefs name), and keeping a content hash of an erased
recording is harder to defend than keeping nothing. A stub would also have to be
filtered out of every list query, forever.

### 2.3 What a consumer sees afterwards

| Read | Before | After a delete |
| :--- | :--- | :--- |
| `GET /api/v1/posts/{postId}` | the view | **`410`**, code `POST_DELETED` (new). A never-existent id stays `404`. |
| `GET /api/v1/posts/{postId}/replies` | the replies | `404`, as for a missing post |
| `GET /api/v1/posts` lists, `rootAuthor` lists | include it | omit it |
| XRPC `getPost`, `getThread` | the record | `RecordNotFound` (atproto has no "gone") |
| XRPC `getPlaybackUrl`, `GET /api/v1/audio` | playable | `404` once the blob is deleted |
| `POST /api/v1/posts` replying to it | allowed | `404` parent not found, as today for a missing parent |
| A kept reply's view | `record.reply.parent` names the post | unchanged; resolving that URI now fails |

The `410` is visible only to the tenant that owned the post, because every read
is tenancy-scoped already. It tells the tenant something it did itself.

**Copies Antiphony cannot reach.** Public (flat) audio is served
`Cache-Control: public, max-age=31536000, immutable`, so a browser or an
intermediate cache may keep a copy for up to a year. Audio in a space is served
only from signed URLs that expire within an hour, with `Cache-Control: private`.
Vox Pop's replies live in reply spaces, so this matters for its prompts, not its
replies. Anything a tenant copied into its own storage (Vox Pop's enrichment
rows, transcripts it cached) is the tenant's to delete.

**Federation.** Nothing has left Antiphony yet: there is no firehose, and Phase 3
sync is not built. When it is, a deletion becomes a delete op in the space repo
commit, and any export from before a deletion is followed by the ledger's delete
ops. Copies held by third parties are then best-effort, which is what
[`atproto-authority-model.md`](./atproto-authority-model.md) § Deferred already
says and what Vox Pop's pages must not overstate.

## 3. Replies below a deleted post

### 3.1 Why replies can't be moved

A reply's URI is sealed into the CID of every reply beneath it (its StrongRef),
and a reply in a space has the space in its URI. Moving a kept reply out of its
reply space into a standalone post would change its URI and CID, break the
StrongRefs of anything replying to it, and contradict `spaces.md` ("a post's
space is fixed at creation"). So a kept reply stays where it is, in the same
space, with the same URI and CID.

The space stays too. It is closed in practice: a new reply under the deleted
prompt fails, because `createPost` must resolve the reply's parent and root and
the root is gone. A reply to a kept reply fails the same way, because
`reply.root` must name the stored thread root. No "closed" flag is needed.

### 3.2 The `replies` option

Every delete names what happens to the replies below the post (its subtree:
replies to it, replies to those, and so on):

| `replies` | Effect |
| :--- | :--- |
| `delete` (default) | Every reply in the subtree is deleted with the post. |
| `keep` | Only the post is deleted. Every reply stays, with a dangling parent. |
| `keep-with-did` | Each reply in the subtree is judged on its own: kept if it has an `authorDid` facet, deleted if not. |

`keep-with-did` is decision 2 as a platform rule, and it is a general one: a
reply whose author has their own atproto identity is that author's statement,
not part of the thread's property. It reads only a facet Antiphony already holds
(`authorDid`), so it needs no knowledge of Vox Pop's users. Each reply is judged
independently, so a kept reply's own children without a DID are still deleted.

The default is `delete` because it is the data-minimising choice and matches
decision 2's general rule. A caller that wants Bluesky's behaviour (deleting a
post never touches anyone else's) passes `keep`.

### 3.3 The kept reply's facets

A kept reply still carries `rootAuthorId` (the erased creator's id) and, in
`threadParticipants`, the same id. **Recommendation: leave them.** Under D5 those
ids are opaque and only the tenant can resolve them; once the tenant erases its
own user row, they resolve to nobody. Scrubbing them would mean relaxing the
`posts_kind_matches_reply` constraint and the record schema's refine, both of
which require a reply to have a root author, for no gain the tenant's own erasure
doesn't already give. (Decision point D-3 below.)

## 4. The routes

All three use the service token; none needs an acting actor (§ 5).

### 4.1 `DELETE /api/v1/posts/{postId}`

Query: `replies` = `delete` | `keep` | `keep-with-did` (default `delete`).

```json
{
  "success": true,
  "data": {
    "status": "deleted",
    "complete": true,
    "deleted": [{ "postId": "3kb2…", "uri": "at://…", "kind": "prompt" }],
    "kept": [{ "postId": "3kb3…", "uri": "at://…" }]
  }
}
```

- `status`: `deleted` when this call removed the post, `already-deleted` when the
  ledger already has it, `pending` while the subtree needs more calls. The second
  is still `200`: the caller asked for the post to be gone, and it is.
- `complete`: `false` when the subtree was larger than one call deletes (§ 7).
  Replies are removed deepest first and the post itself last, so a partial call
  never leaves replies whose deletion was asked for under a missing parent. Call
  again with the same `replies` until `complete` is `true`.
- `deleted` lists every post this call removed, the post and its replies; `kept`
  lists replies this call left in place (`keep`, `keep-with-did`). Each list is
  capped at the page size.
- `404` when the id names no post and no ledger row, or another tenant's post
  (tenancy reads as absence, as everywhere else).

### 4.2 `POST /api/v1/authors/{authorId}/erase`

Account erasure. Deletes every post whose `authorId` is `authorId`, prompts and
replies, applying `replies` to the subtrees below them.

Body: `{ "replies": "delete" | "keep" | "keep-with-did", "limit"?: 1–200 }`
(defaults `delete`, 100).

Response: the same `deleted`, `kept` and `complete` as § 4.1, with no `status`.
Each call deletes up to `limit` posts and reports `complete: false` while any of
the author's posts remain, so the caller loops. Calling it after it has finished
returns `complete: true` and empty lists, which is what makes Vox Pop's
retry-until-done job safe.

The author's replies under other people's prompts are deleted whatever
`replies` says: `replies` governs other people's replies below the author's
posts, never the author's own posts.

### 4.3 `DELETE /api/v1/spaces/{spaceType}/{skey}`

Deletes an empty space. `409` with code `SPACE_NOT_EMPTY` while any post is in it
(the foreign key from `posts` already refuses), and `200` with
`{ "deleted": false }` when there is no such space, so it is idempotent. Vox Pop
calls it after erasing a prompt whose reply space kept nothing.

## 5. Who may delete

- **The service token is the only credential**, as on every data route. Tenancy
  comes from the token, so a tenant can only ever delete its own posts and
  spaces.
- **No acting actor is required, and Antiphony does not check that the actor wrote
  the post.** Who may delete a post is a product decision, the same way who may
  hear one is: a listener deleting their own reply, a creator removing a reply to
  their prompt, and an operator running an erasure all look the same from here.
  This is the managing-app principle from
  [`cross-repo-design.md`](./cross-repo-design.md) § 1: Antiphony enforces
  tenancy and the tenant decides access.
- If an acting actor is sent, it is logged with the request id for the tenant's
  own audit, and not stored. The ledger keeps no actor, because the actor of an
  erasure is often the person being erased.
- **Signed service auth** (`X-Antiphony-Service-Auth`) stays observation-only;
  nothing here changes that.
- **Authority.** The ledger's URI uses the same authority the post's URI had (the
  tenant's pinned DID today; an org's DID once multi-authority writes exist).
  Deleting changes no authority and no DID document.

## 6. Idempotency and shared blobs

### 6.1 One transaction, then the bytes

A delete runs in two steps:

1. **One database statement:** delete the post rows (with `returning`), delete
   their transcripts, write their ledger rows, and insert every candidate CID
   (original, processed, derived) into `blob_deletions (origin_app_id, cid,
   enqueued_at)`.
2. **Drain:** for each queued CID, check whether any remaining post in the tenant
   references it. If none does, delete `blobs/{app}/{cid}` and its renditions in
   one R2 batch call, then remove the queue row. If one does, just remove the
   queue row.

Why the queue: if the bytes were deleted first and the transaction then failed,
a retry would find the post intact and its audio gone. If the rows were deleted
first and the R2 call then failed, nothing would point at the bytes any more and
they would stay forever. Queuing the CIDs in the same transaction as the rows
means a crash between the steps leaves a row saying what still needs deleting.

The drain runs at the end of every delete call and from the existing hourly cron
(`apps/core-api/wrangler.jsonc`), so a crashed or partial drain finishes within
the hour without the caller doing anything.

### 6.2 "Never delete a blob another record still references"

The reference check is made at drain time, not at enqueue time, so a post
created between the two steps keeps its audio. A blob counts as referenced when
any post in the same tenant has it as its original audio, its processed variant
or one of its derived variants. Migration `0003` promotes the first two to
indexed generated columns and indexes the third, so the check is one indexed
query for the whole batch.

**Two narrow races, accepted and stated:**

- A tenant uploads bytes identical to a blob that is about to be drained, and
  creates its post after the drain. The upload was a no-op (the first upload
  wins), so the new post names audio that is gone. It needs the same bytes,
  in the same tenant, within seconds of the erasure; the fix is a re-upload.
- A processing pass writes a derived blob for a post being deleted. If the delete
  commits first, the pass's settle updates no row; it then queues the blob it
  just wrote for the drain. If the settle commits first, the delete finds the
  CID in the post's state. Either way the blob is collected.

### 6.3 Repeated, concurrent and partial calls

- Repeated: `already-deleted`, `200`. Erase: `complete: true`, empty lists.
- Concurrent: the row delete's `returning` decides which call removed which post;
  the other sees the ledger. R2 deletes of missing keys succeed.
- A lease held by a running processing pass does not block deletion. Erasure must
  not be held up by a stuck lease, and § 6.2 covers what the pass writes.

## 7. Bulk erasure: limits and cost

- **Paged, synchronous, and resumable.** One call deletes at most `limit` posts
  (author erase) or 200 posts (one post's subtree), then drains. That bounds every
  call well inside the Worker's CPU and subrequest limits, and the caller's loop
  is the job runner. No queue or job table is added for it.
- **Per post:** the row delete, transcript delete, ledger insert and enqueue
  are batched per call, not per post. R2 takes up to 1,000 keys per delete call,
  so a page of 200 posts with three blobs and their renditions each is two R2
  calls.
- **Cost:** R2 deletes are free; the reference check is one indexed query per
  page; Neon pays for a few statements per page. An erasure of an account with
  thousands of posts is tens of calls.
- **Rate limits:** `writeAggregate` on both routes. Per post: `burst` (20 a
  minute) keyed by acting actor, so a person deleting their own replies is never
  throttled. Author erase: `burst` keyed by the tenant, so an operator job runs at
  up to 20 pages a minute.

## 8. Telling the tenant

The response is the authoritative record of what a call deleted. The caller
already knows, because it asked.

A `post.deleted` webhook is also sent per deleted post, through the same
per-tenant URL, secret and HMAC as stage events
([`enrichment-webhooks.md`](./enrichment-webhooks.md)), best-effort and
after the transaction commits:

```json
{
  "type": "post.deleted",
  "originAppId": "voxpop",
  "postId": "3kb2…",
  "uri": "at://…",
  "kind": "reply",
  "occurredAt": "2026-10-20T14:03:11.204Z"
}
```

Stage events gain `"type": "stage.settled"` so a receiver can tell the two apart.
Adding a key to the stage payload is additive. No consumer receives the webhook
today (Vox Pop still pulls), so nothing breaks. Kept replies get no event:
nothing about them changed.

## 9. Not in this change

- **Orphan sweep** for unrecorded variants and abandoned uploads (§ 1.1). Needs a
  grace period long enough that an upload whose post is still being created isn't
  swept.
- **XRPC `dev.antiphony.audio.deletePost`.** The XRPC surface is heading to parity
  ([`xrpc-surface.md`](./xrpc-surface.md)); deletion joins it with a lexicon when
  that work picks up the remaining REST routes.
- **Delete ops in sync or export.** Phase 3; the ledger is the input.
- **Undo.** There is none. Vox Pop's deactivation (archive, not erase) is the
  reversible step, and it lives in Vox Pop.

## 10. Versioning

Under [`api-versioning.md`](./api-versioning.md):

- **New routes** (§ 4) are additive.
- **New states of existing data are not.** Until now a reply's parent StrongRef
  always resolved, and `GET /api/v1/posts/{postId}` answered only `200` or `404`.
  After this change a consumer holding a reply may find its parent gone, and a
  read may answer `410`. That is the meaning-only kind of change the policy
  classes as breaking (the `0.4.0` precedent), even though no field moves.
- So the contract goes **`0.9.2` → `0.10.0`**, with a `CHANGELOG.md` entry that
  marks the `410` and the dangling parent **BREAKING**.
- **`@antiphony/shared`** gains the request and response schemas and
  `derivedBlobCids` on `ProcessingStateSchema` (optional, internal). That needs a
  package minor (`0.9.2` → `0.10.0`) on the package axis, released separately.
  Vox Pop's exact pin stays on `0.9.1` until it moves.

## 11. Decision points for review

| # | Question | Recommendation |
| :--- | :--- | :--- |
| D-1 | Hard delete with a content-free ledger, or a stub record? | Hard delete with a ledger (§ 2.2). |
| D-2 | Default for `replies`? | `delete` (§ 3.2). |
| D-3 | Scrub the erased author's id from kept replies' facets? | No (§ 3.3). |
| D-4 | Require the acting actor to be the post's author? | No; tenancy only (§ 5). |
| D-5 | `410` for a deleted post, or keep `404`? | `410`, tenant-only (§ 2.3). |
| D-6 | Contract minor (`0.10.0`) or patch (`0.9.3`)? | Minor (§ 10). |
| D-7 | Record `derivedBlobCids` in this change, orphan sweep later? | Yes (§ 1.1). |

## 12. As built (2026-10-27)

- **One statement, not a transaction.** `SqlClient` runs one statement at a time over
  HTTP and can't hold a transaction open, so `deletePosts` is one statement whose
  data-modifying CTEs delete the rows and transcripts, write the ledger and queue the
  blobs (`apps/core-api/src/adapters/outbound/postgres/post-deletion-dependencies.ts`).
  A statement is atomic, which is the property § 6.1 needs.
- **Re-queueing during a drain.** A CID queued again while a drain is deleting it moves
  its `enqueued_at`, and the drain only removes rows whose timestamp it read, so the
  second request survives that drain and is re-checked by the next.
- **A settle that finds its post gone queues the blob it carried**, in the same
  statement as the failed update (`audio-processing-dependencies.ts`). This is § 6.2's
  second race, closed in the adapter rather than the service.
- **`status: 'pending'`** was added to the single-post response for a subtree that needs
  more calls; § 4.1 only named the two finished states.
- **Thread lookup.** The subtree walk reads the whole thread by `reply.root.uri`, a new
  generated column with a partial index (`reply_root_uri`), and walks parent links in
  the service.
- **Author erasure** is keyed for rate limiting by tenant alone, so an operator job that
  asserts different actors still shares one bucket.
- **Code:** `packages/core/services/post-deletion.ts` (the walk, paging and policies),
  `packages/core/ports/post-deletion-dependencies.ts`, `packages/core/ports/deletion-notifier.ts`,
  `apps/core-api/migrations/0003_deletion.sql`, `apps/core-api/src/adapters/inbound/rest/authors.ts`,
  and the `DELETE` routes in `rest/posts.ts` and `rest/spaces.ts`.
- **Tests:** `packages/core/services/post-deletion.test.ts` (policies, ordering, paging,
  idempotency, erasure), `apps/core-api/src/adapters/outbound/postgres/post-deletion.test.ts`
  (against Postgres: shared blobs, variants as references, tenant isolation, replies kept
  in a reply space, R2 failure and retry, re-queue, the mid-pass race), and
  `apps/core-api/src/adapters/inbound/rest/deletion.test.ts` (the routes and the `410`).
