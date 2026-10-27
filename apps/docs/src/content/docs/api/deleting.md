---
title: Deleting posts and audio
description: Hard deletes of posts, their audio and their replies, and erasing everything one author wrote.
---

Antiphony deletes for real. Deleting a post removes its record, its transcript, and every blob and rendition of its audio that no other post of yours still uses. What's left is a ledger row holding only the post's URI and when it was deleted, with no text, audio, CID or author.

That is how AT Protocol works too. A repo keeps no stub for a deleted record: it is simply gone, and only the fact that it was deleted is recorded. The design and its reasoning are in [`specs/deletion.md`](https://github.com/bbthorson/antiphony/blob/master/specs/deletion.md).

## Delete one post

```bash
curl -sS -X DELETE "$API/api/v1/posts/$POST_ID?replies=delete" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "success": true,
  "data": {
    "status": "deleted",
    "complete": true,
    "deleted": [{ "postId": "3kb2…", "uri": "at://…", "kind": "prompt" }],
    "kept": []
  }
}
```

- **`status`** is `deleted` when this call removed the post, and `already-deleted` when it was already gone. Both are a `200`: you asked for the post to be gone, and it is. It is `pending` while the post's replies still need more calls (below).
- **`deleted`** lists every post the call removed, the post and its replies. **`kept`** lists replies it left in place.
- **`404`** means you never had a post with that id. Another app's post reads the same way.

No acting actor is needed. Who may delete a post (its author, the person they were talking to, an operator handling an erasure request) is your app's decision; Antiphony only checks that the post is yours. If you send `X-Antiphony-Acting-Actor`, it is logged with the request and not stored.

## The replies below a post

`replies` decides what happens to every reply in the post's subtree: replies to it, replies to those, and so on.

| `replies` | Effect |
| :--- | :--- |
| `delete` (default) | Every reply in the subtree is deleted with the post. |
| `keep` | Only the post is deleted. The replies stay. |
| `keep-with-did` | Each reply is judged on its own: kept if it has an `authorDid`, deleted if not. |

`keep-with-did` keeps the replies whose authors have their own AT Protocol identity, which you asserted with `X-Antiphony-Acting-Actor-Did` when they replied. Their reply is their statement, so it outlives the post it answered.

A kept reply is **never moved or rewritten**. Its URI is sealed into the CID of every reply beneath it, so moving it would break them all. It keeps its URI, its CID and its space. Its `reply.parent` (and `reply.root`, under a prompt) still names the deleted post, and resolving that URI now fails. Nothing new can be added to that thread, because a reply's parent and root must exist.

### Large threads take more than one call

One call deletes at most 200 posts. Replies are removed deepest first and the post itself last, so a partial call never leaves a reply you asked to delete sitting under a parent that's already gone. While `complete` is `false`, repeat the same call. Each call is idempotent, so a job that retries until `complete` is `true` is safe.

## Erase everything one author wrote

For an account-erasure request:

```bash
curl -sS -X POST "$API/api/v1/authors/$AUTHOR_ID/erase" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "replies": "keep-with-did", "limit": 100 }'
```

This deletes every post whose `authorId` is `$AUTHOR_ID`, prompts and replies, exactly as a `DELETE` of each would. `replies` applies to *other people's* replies below them. The author's own posts are always deleted, wherever they are. Both fields are optional (`delete`, `100`), and `limit` goes up to 200.

The response has the same `complete`, `deleted` and `kept` as above. Call it until `complete` is `true`; calling it again after that returns `complete: true` and empty lists.

## Reading a deleted post

| Read | Afterwards |
| :--- | :--- |
| `GET /api/v1/posts/{postId}` | `410`, `code: POST_DELETED`. An id you never had is still `404`. |
| `GET /api/v1/posts/{postId}/replies` | `404` |
| Lists (`GET /api/v1/posts`, `?rootAuthor=`) | The post is omitted. |
| XRPC `getPost`, `getThread` | `RecordNotFound` |
| The audio proxy | `404` once the bytes are deleted |

Only your own app's deletions are visible to you, as with every other read.

## Shared audio

Blobs are content-addressed and stored per app. If two of your posts use the same bytes, deleting one leaves the audio in place for the other, and the bytes go when the last post using them is deleted. A post's processed variants (denoised, trimmed) count too. Two different apps never share a stored blob, even for identical bytes.

The bytes are removed just after the post's rows. If that step fails, it is retried within the hour without anything from you.

## What Antiphony can't reach

- **Copies of public audio.** Audio outside a space is served `Cache-Control: public, immutable`, so a browser or cache may still hold a copy. Audio in a space plays only from URLs that expire within an hour.
- **Your own copies.** Transcripts, scores or audio your app stored itself are yours to delete.
- **Variants from before deletion shipped**, and **uploads that never became a post**. Nothing records them yet, so a delete can't find them. A cleanup sweep for both is planned.

## Spaces

A space can be deleted once nothing is in it:

```bash
curl -sS -X DELETE "$API/api/v1/spaces/$SPACE_TYPE/$SKEY" \
  -H "Authorization: Bearer $TOKEN"
```

It answers `{ "deleted": true }`, or `{ "deleted": false }` if there was no such space. A space that still holds posts, such as a reply space with a kept reply in it, answers `409` with `code: SPACE_NOT_EMPTY`.

## Webhooks

If your app receives [enrichment webhooks](/build-your-own/overview/#receiving-enrichment-webhooks), each deleted post also sends a `post.deleted` event to the same URL with the same signature. The response to your delete call is the authoritative record of what it removed; the webhook is best-effort.
