---
title: API reference
description: The /api/v1/* endpoints exposed by Antiphony's core.
---

The canonical contract is the **[lexicons](/lexicons/overview/)** — the `dev.antiphony.*` records every endpoint reads and writes. The REST surface is the transport over those records.

A generated, per-endpoint view of the live OpenAPI spec lives at **[/api/reference](/api/reference/)** — Scalar-rendered from `apps/core-api`'s Zod schemas. Treat it as a lookup aid; the [lexicons](/lexicons/overview/) are the contract you design against.

This page covers the high-level shape of the surface and the auth + envelope conventions every endpoint follows.

## What's covered

Every endpoint in the reference lives in **`apps/core-api`** — the open-core service. Apps built on the core may add their own product-specific endpoints on top; those aren't part of this open core and aren't documented here.

The canonical resources:

- **`/posts`** — Create an audio post, get one by id, list posts, list a post's replies (the thread), `PATCH` one to (re)trigger [audio enrichment](/self-hosting/configuration/#audio-enrichment), and [`DELETE`](/api/deleting/) one with its audio. One record type; `reply` presence is prompt-vs-reply.
- **`/spaces`** — Create, replace, read and delete your app's [atproto spaces](#private-audio-in-a-space): permissioned places for posts whose audio isn't public.
- **`/authors`** — [Erase](/api/deleting/#erase-everything-one-author-wrote) every post one author wrote, for an account-erasure request.
- **`/audio`** — Upload audio (content-addressed — see [Lexicons § How faithful is this to AT Protocol?](/lexicons/overview/#how-faithful-is-this-to-at-protocol)), optionally into a space, and stream stored audio back (`GET /api/v1/audio`, with range support and optional mp3 renditions): from a stable, non-expiring URL for public audio, and a signed one that expires in an hour for audio in a space.

`GET /api/v1/posts` is one endpoint with two slices: by default the **viewer's own** posts (optionally filtered by `kind`), and with `?rootAuthor=<id>` the replies whose thread root that id authored — "replies addressed to X", the raw feed you'd compose an inbox from. That's [queries, not bespoke views](/explanation/api-design-principles/#2-queries-not-bespoke-views) in practice.

That's the whole public contract: Antiphony is a headless post store plus audio hygiene. There is no user/profile/handle surface — end-user identity and profile data (display name, bio, handle claiming, OAuth linking UX) belong to the calling application, and the acting actor's AT Protocol DID is asserted per request (`X-Antiphony-Acting-Actor-Did`), never registered. See [service auth](#authentication) below.

Internal/utility routes (`/api/v1/system/*` service-to-service glue) intentionally stay out of the public reference — they're plumbing a third-party client wouldn't call, gated by a separate `SYSTEM_AUTH_TOKEN` rather than an app service token.

## Reply gating

Replies are **not** an open comment thread — the AppView enforces who may reply, and clients should reflect that:

- **Replying to a prompt** is open to any authenticated viewer (the app's default audience policy).
- **Replying to a reply** is restricted to that branch's **two participants** — the prompt's author (the creator) and the responder who opened the branch. Anyone else gets a `403`.

So each top-level reply is a private creator ↔ responder back-and-forth no third party can join.

A reply's `reply` StrongRefs must name the stored records: `parent` is the post being answered, with its current `cid`, and `root` is that thread's prompt, with its `cid`. Both are sealed into the reply's own CID, so a stale or placeholder CID is refused with a `400` (`code: REPLY_CID_MISMATCH`; XRPC `ReplyCidMismatch`), and a `root` that isn't the thread's prompt with a plain `400`. Take both from the `uri` and `cid` of the posts you're answering. The rule is enforced on **write** (`POST /api/v1/posts` rejects a disallowed reply) and surfaced on **read**, so you don't have to reimplement it: every `AudioPostView` carries a `viewer` block with

- **`canReply`** — whether the current caller may reply to this post, and
- **`replyDisabledReason`** — `unauthenticated` or `not_a_participant` when they can't.

Drive your reply affordance off `viewer.canReply`. (An app that wants different rules — open public threads, say — is a future `app.bsky.feed.threadgate` override; participant-only is the default.)

## Authentication

Antiphony is meant to be called by an **application** (a BFF, a worker), not directly by end-user browsers. The **service token is the only accepted credential** — every data route requires it. Your app authenticates with its own service token (`ANTIPHONY_APP_TOKENS` — provisioned by whoever runs the deployment) and asserts which of *its* users is acting:

```
Authorization: Bearer <your-app-service-token>
X-Antiphony-Acting-Actor: <your-internal-user-id>
X-Antiphony-Acting-Actor-Did: <their-at-protocol-did>   # optional
```

Your app's tenancy (`originAppId`) is derived from the token — Antiphony never sees your end users' credentials, and you never see Antiphony's. Antiphony verifies no end-user identity tokens. Full contract: [`specs/service-auth.md`](https://github.com/bbthorson/antiphony/blob/master/specs/service-auth.md).

The acting-actor header is the optional axis: required on writes and viewer-scoped reads, omitted for an anonymous, tenancy-scoped read. Deletes don't need it: who may delete is your app's decision (see [Deleting posts and audio](/api/deleting/)). A request with no service token gets a `401` on every data route — "public" means "no viewer," not "no tenant."

The sole anonymous exception is the audio playback proxy (`GET /api/v1/audio`), which is capability-based: allowlisted content-addressed `blobs/` paths resolved to audio bytes or derived renditions (e.g. mp3). Audio in a space also needs a signature in the URL (below).

:::note[Audio is public unless it's in a space]
Audio uploaded outside a space is content-addressed and public by CID, including blobs uploaded before being attached to a post. Anonymous callers can trigger on-demand transcodes of public audio through the audio proxy. Byte range requests adhere to RFC 7233: requesting an offset beyond the total file size returns `416 Range Not Satisfiable` with a `Content-Range: bytes */<totalSize>` header.
:::

## Private audio in a space

A **space** is an [atproto space](https://github.com/bbthorson/antiphony/blob/master/specs/spaces.md): a permissioned place for records, named by a type (an NSID) and a key, with your app's DID as its authority (or a DID your app registered; see [DIDs your app acts for](#dids-your-app-acts-for)). Posts in a space have space URIs (`at://{authority}/space/{type}/{skey}/{authorSegment}/dev.antiphony.audio.post/{rkey}`), and their audio plays only from **signed URLs that expire after an hour**. Your app decides who may listen: it's the space's managing app, and a signed URL is what Antiphony hands back when you ask on someone's behalf.

1. **Create the space** — `PUT /api/v1/spaces/{spaceType}/{skey}` with `{ readPolicy?, writePolicy? }` (both default to `member-list`). Idempotent; the body replaces the policies. A DID is a valid `skey`, which is how you'd key a per-user space.
2. **Upload into it** — add `spaceType` and `skey` fields to the `POST /api/v1/audio/upload` form. The response's `space` says where the blob lives. **The first upload of a given set of bytes decides this**, so re-uploading identical bytes can't make private audio public, or the reverse. One thing does make it public, for good: registering a public [remote post](#posts-held-in-another-repo) whose repo serves the same bytes, since they are public there already.
3. **Post into it** — `POST /api/v1/posts` with `space: { type, skey }`. The space must exist (`404`), the audio must live in the same space, and a flat post can't use audio that lives in one (`400` either way). A reply's placement is never less private than its parent's:
   - a reply to a post in a space goes in that space, whether or not it names it; naming a different one is a `400`.
   - a reply to a public (flat) post may name a space, which is how a public prompt gets replies only some people can hear. Without one it's public too.

The author segment of a space URI (the DID after the key) is chosen per post with `spaceAuthor`:

- `authority` (the default): your app's DID. Use it for what your app keeps: a contribution from someone outside the group, or work your app generates.
- `actor`: the acting person's own DID, from `X-Antiphony-Acting-Actor-Did`, which must be a valid DID. Use it for a member's own record, which can later move to their own repo under the same URI. A flat post has no author segment, so `actor` on one is a `400`.

Either way the person is also the post's `author` (`authorId` / `authorDid`), outside the record's CID. The segment is sealed into every reply's StrongRef, so choose it deliberately. See [the decision record](https://github.com/bbthorson/antiphony/blob/master/specs/audio-service-and-groups.md).
4. **Play it** — post views carry a signed `embed.audio.url`, and `dev.antiphony.audio.getPlaybackUrl` signs on request. Fetch a fresh one rather than storing it. Without a valid signature the proxy answers `404`, as it does for audio that doesn't exist. You may append `format=mp3`. Responses are `Cache-Control: private` and never cached past the signature.

A deployment without `ANTIPHONY_PLAYBACK_SECRET` answers `503` to `PUT /spaces` (see [configuration](/self-hosting/configuration/#core-variables)).

## DIDs your app acts for

Your app writes under its own DID, pinned when it was onboarded. To also act for another DID whose document names this Antiphony, such as one your app created for a game table or an organization, register it with `PUT /api/v1/dids/{did}` and `{ "role": "group", "subjectRef": "<your id for it>" }`.

:::note[Not for opensocial groups]
An [opensocial](https://tangled.org/opensocial.group/proposal) group's DID names its group host as its PDS, never Antiphony, so it can't be registered here, and records under it live on the group's host. To process audio whose record lives in another repo, such as a group's or a member's, register it as a [remote post](#posts-held-in-another-repo).
:::

- **The DID's document must name this Antiphony as its space host** (`#atproto_space_host`), as your app DID's does. Antiphony checks before keeping the registration: `400 DID_CUSTODY_DISPROVED` if it doesn't, `503 DID_UNREACHABLE` if the document can't be read right now.
- **A DID belongs to one app.** Another app's DID is `409 DID_TAKEN`.
- **Registrations aren't rewritten.** Repeating one returns it unchanged (`200`); a different role or subject is `409 DID_REGISTERED_DIFFERENTLY`.
- `GET /api/v1/dids` lists yours, newest first. `DELETE /api/v1/dids/{did}` unregisters one, once nothing is under it (`409 DID_IN_USE` otherwise).

Once registered, name it as the **authority** of what you write:

- `POST /api/v1/posts` with `authority: "<did>"` writes the post at `at://<did>/…`. A `space` it names must exist under that authority.
- `PUT /api/v1/spaces/{spaceType}/{skey}?authority=<did>` creates a space under it; `GET` and `DELETE` take the same parameter. Two groups can each have a space with the same type and key.
- `POST /api/v1/audio/upload` takes `spaceAuthority` beside `spaceType` and `skey`.
- **A reply always has its parent's authority.** Omit it, or name the same one.
- Each write under a registered DID re-checks that its document still names this Antiphony (`503 AUTHORITY_CUSTODY_UNPROVEN` if not); an unregistered one is `400 AUTHORITY_NOT_REGISTERED`.

## Posts held in another repo

A **remote post** is a `dev.antiphony.audio.post` record that lives in a repo Antiphony doesn't host: a person's own PDS, or a group's repo on its group host. Your app writes the record there, then registers it here; Antiphony copies and processes its audio, plays it, and drops its copy once the record is gone. Public records are read here; a record in a space is pushed by your app ([below](#records-in-a-space)).

1. **Register it** — `PUT /api/v1/remote-posts` with `{ "uri": "at://{did}/dev.antiphony.audio.post/{rkey}", "cid": "<record CID>", "processing"?: { … } }`. Antiphony reads the record from the repo its URI names, never from your request:
   - its CID must be `cid` (`409 REMOTE_CID_MISMATCH` if the record changed since you read it);
   - it must be an audio post whose blob's bytes hash to the blob ref and are audio (`422 REMOTE_RECORD_INVALID`);
   - `404 REMOTE_RECORD_NOT_FOUND` if the repo says it doesn't exist, `503 REMOTE_REPO_UNREACHABLE` if the repo can't be read right now.
   
   Repeating a registration is a no-op; a new `cid` takes the edit. If you uploaded the same bytes with `POST /api/v1/audio/upload` first, they aren't downloaded again (`"bytesFrom": "upload"` requires that). Audio stored here as private for a space is the exception: Antiphony downloads it from the record's repo, checks it, and makes it public, original and processed variants, since a public record already makes it public there.
2. **Read it** — `GET /api/v1/remote-posts?uri=…`, and `GET /api/v1/remote-posts/thread?root=…` for the registered replies under a root (Antiphony doesn't crawl for replies). The view carries `uri`, `cid`, `authorDid` (the DID whose repo holds it), `space` for a space record, `verified` and `deletionCheck` (below), the record, and the same `embed` a hosted post gets: a playback URL, the transcript and the processing status.
   - **List them** with `GET /xrpc/dev.antiphony.audio.listRemotePosts` (or `GET /api/v1/remote-posts/list`): your registered remote posts, newest first, optionally narrowed by `repo` (a DID), `space` (a space URI) and `kind` (`prompt` or `reply`). Page with `limit` (1–100, default 50) and `cursor`. The answer is `{ posts, cursor }`, as atproto lists are, and `cursor` is absent on the last page.
   - **Fetch several** with `GET /xrpc/dev.antiphony.audio.getRemotePosts?uris=…&uris=…` (or `GET /api/v1/remote-posts/batch`): up to 25 URIs, answered in the order asked. A URI you haven't registered is left out.
3. **Process it** — `processing` on registration, or later with `PATCH /api/v1/remote-posts?uri=…`. Results arrive as `stage.settled` webhooks carrying the post's `uri` and no `postId`.
4. **Remove it** — `DELETE /api/v1/remote-posts?uri=…` removes Antiphony's copy (the record in its repo is untouched); a later read is `410 REMOTE_POST_DELETED`.

Antiphony rechecks each public remote post hourly. A record its repo reports gone on two checks an hour apart is removed, and you get a `remote.gone` webhook; an edited record is taken and reprocessed, with a `remote.changed` webhook. A repo that can't be reached never causes a removal, but after 30 days the post reads `available: false` and stops playing.

### Records in a space

A record in a space (a player's reply in a group's campaign space, say) is in the player's own repo, readable only to the space's members. There are two ways to register one.

**On a delegation (recommended).** Antiphony reads the record itself, on a member's say-so:

1. **Mint a delegation** from a member's PDS: `com.atproto.space.getDelegationToken?space=at://{authority}/space/{type}/{skey}`, using a session you hold for someone who can read the space. Your OAuth client needs a space read scope for the space type. The token is single use and lives 60 seconds, so mint it right before the next step.
2. **Register** with `PUT /api/v1/remote-posts`, sending the space record's URI (`at://{authority}/space/{type}/{skey}/{authorDid}/dev.antiphony.audio.post/{rkey}`), its `cid` and `delegationToken`. Add `clientAttestation` for a space that only admits listed apps.
   - Antiphony exchanges the token at the space's authority for a credential bound to its own key. It reads the record from the writer's PDS (checking the host's record MAC) and then the audio, both checked as for a public record. The audio is stored private for the space.
   - `403 REMOTE_DELEGATION_REFUSED` means the authority won't issue a credential: the member may not read the space, or the token was spent. A host gives the same answer for a space that doesn't exist, so this never means it's gone. A deleted space is `404 REMOTE_RECORD_NOT_FOUND`.

   The view says `verified: "fetched"` and `deletionCheck: "recheck"`.

**Pushed.** If you can't mint delegations yet, send what you read:

1. **Upload the audio for the space** with `POST /api/v1/audio/upload`, setting `remoteSpace` to the space's URI. The blob is stored private for that space; no Antiphony space is needed, and the authority is the group's DID.
2. **Register the record with its body**: `PUT /api/v1/remote-posts` with the URI, `cid`, and `record`, the record as you read it.
   - Antiphony checks that `record` hashes to `cid` and is an audio post (`422 REMOTE_RECORD_INVALID`).
   - It checks that the audio is your upload for that same space: `422` if you never uploaded it, and `409 REMOTE_BLOB_SPACE_MISMATCH` if it's stored for another space, or public with no public record using it.

   The view says `verified: "pushed"`: Antiphony checked the content, not that you can read the space. **Antiphony can't see a pushed record deleted, so your `DELETE` is the only way its copy goes** (`deletionCheck: "tenant"`) until a recheck reads it. If your app can't commit to sending it, don't register members' records this way.

Either way, a space record's audio plays only from signed, expiring URLs, and a space record never makes audio public.

**Rechecks.** A space credential lasts ten minutes, so Antiphony can't hold one between its hourly checks.
- Instead it asks you: a `remote.recheck_requested` webhook carrying the space's URI, sent hourly for each space that's due and has a record read on a delegation.
- Answer with `POST /api/v1/remote-posts/recheck` and `{ "space": "…", "delegationToken": "…" }`, using a fresh delegation from any member session.
- Antiphony reads every due record in that space with that one delegation. It takes edits (`remote.changed`) and removes records gone on two rechecks an hour apart (`remote.gone`). A pushed record that reads back unchanged becomes `fetched`.
- One call reads at most 100 records; if the answer says `remaining: true`, call again with another delegation.
- You can call it without being asked, for example to upgrade records you pushed.

## Envelope

Every JSON response wraps its payload:

- **Success:** `{ success: true, data: T }`
- **Failure:** `{ success: false, error: { message, code?, issues? }, requestId }`

Paginated lists nest the cursor inside `data`:

```json
{
    "success": true,
    "data": {
        "items": [...],
        "nextCursor": "the-id-of-the-last-item-or-null"
    }
}
```

The `requestId` correlation ID appears in every error response and as the `X-Request-ID` response header on every request — propagate it from your client (`X-Request-ID: <uuid>`) for end-to-end tracing across `core-api` and downstream logs.

## Limits

Four categories of limits are worth designing around before you write a client.

**Request body and string bounds.** JSON endpoints (`POST /api/v1/posts`, `PATCH /api/v1/posts/:postId`) enforce a **256 KB** maximum request body limit (`413 Content Too Large`). Key string fields are bounded to guard against resource exhaustion:
- `langs`: maximum 3 entries, each up to 35 characters.
- `selfLabels`: maximum 10 entries, each up to 128 characters.
- `StrongRef.uri`: maximum 512 characters.
- `StrongRef.cid`: maximum 128 characters.

**Upload size and type.** `POST /api/v1/audio/upload` accepts a `multipart/form-data` body with a single `file` field, up to **25 MB**, and only these MIME types:

`audio/m4a` · `audio/x-m4a` · `audio/mp4` · `audio/mpeg` · `audio/webm` · `audio/ogg` · `audio/wav`

The match is exact, so strip any codec parameter first — `MediaRecorder` produces `audio/webm;codecs=opus`, which is rejected as-is. Anything outside the list, or over the cap, is a `400`.

:::note
The `dev.antiphony.embed.audio` lexicon permits `audio/*` up to 100 MB. That's the **record's** ceiling — what a portable record may legally describe. This endpoint is deliberately tighter; size your client to the numbers above, not to the lexicon.
:::

**Rate limits.** Every route carries rate limits. Crucially, limits are **keyed on the actor** (`X-Antiphony-Acting-Actor`), or the tenant (`originAppId`) for viewer-less reads, rather than bare client IP. This ensures multiple users behind a shared NAT or corporate proxy do not share or deplete each other's limits. High-capacity aggregate IP limiters run alongside actor limits to protect against distributed abusive bursts. Exceeding a limit returns `429`:

| Operation | Actor Limit | Aggregate IP Limit |
|---|---|---|
| Writes (`POST`/`PATCH /posts`) | 10 per 15 min | 120 per 15 min |
| Reads (`GET /posts`, `/posts/{id}`, `/posts/{id}/replies`, `/spaces/…`, `/audio`) | 60 per min | 600 per min |
| Space writes (`PUT /spaces/…`) | 20 per min | 600 per min |
| Uploads (`POST /audio/upload`) | 20 per hour | 120 per 15 min |

The write limit is tight enough to hit while developing — back off rather than retrying immediately.

**Idempotency.** `POST /api/v1/posts` honours an `Idempotency-Key` header. Keys are scoped per tenant (`originAppId`) and per actor. If a create request fails validation or an internal service error occurs, the idempotency claim is **immediately released**, allowing your client to correct and retry without waiting for key expiration. A successful response caches the result for replay upon identical retries.

## Source of truth

The reference is generated at build time from the Zod request/response schemas declared in [`apps/core-api/src/adapters/inbound/rest/*.ts`](https://github.com/bbthorson/antiphony/tree/master/apps/core-api/src/adapters/inbound/rest). When a route's contract changes there, `npm run gen:openapi -w @antiphony/core-api` regenerates `openapi.json` and this site rebuilds. Those same schemas mirror the [lexicons](/lexicons/overview/), so the wire format and the portable records stay in lockstep.
