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

- **`/posts`** — Create an audio post, get one by id, list posts, list a post's replies (the thread), and `PATCH` one to (re)trigger [audio enrichment](/self-hosting/configuration/#audio-enrichment). One record type; `reply` presence is prompt-vs-reply.
- **`/audio`** — Upload audio (content-addressed — see [Lexicons § How faithful is this to AT Protocol?](/lexicons/overview/#how-faithful-is-this-to-at-protocol)), and resolve a stored ref to a short-lived signed playback URL.

`GET /api/v1/posts` is one endpoint with two slices: by default the **viewer's own** posts (optionally filtered by `kind`), and with `?rootAuthor=<id>` the replies whose thread root that id authored — "replies addressed to X", the raw feed you'd compose an inbox from. That's [queries, not bespoke views](/explanation/api-design-principles/#2-queries-not-bespoke-views) in practice.

That's the whole public contract: Antiphony is a headless post store plus audio hygiene. There is no user/profile/handle surface — end-user identity and profile data (display name, bio, handle claiming, OAuth linking UX) belong to the calling application, and the acting actor's AT Protocol DID is asserted per request (`X-Antiphony-Acting-Actor-Did`), never registered. See [service auth](#authentication) below.

Internal/utility routes (`/api/v1/system/*` service-to-service glue) intentionally stay out of the public reference — they're plumbing a third-party client wouldn't call, gated by a separate `SYSTEM_AUTH_TOKEN` rather than an app service token.

## Reply gating

Replies are **not** an open comment thread — the AppView enforces who may reply, and clients should reflect that:

- **Replying to a prompt** is open to any authenticated viewer (the app's default audience policy).
- **Replying to a reply** is restricted to that branch's **two participants** — the prompt's author (the creator) and the responder who opened the branch. Anyone else gets a `403`.

So each top-level reply is a private creator ↔ responder back-and-forth no third party can join. The rule is enforced on **write** (`POST /api/v1/posts` rejects a disallowed reply) and surfaced on **read**, so you don't have to reimplement it: every `AudioPostView` carries a `viewer` block with

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

The acting-actor header is the optional axis: required on writes and viewer-scoped reads, omitted for an anonymous, tenancy-scoped read. A request with no service token gets a `401` on every data route — "public" means "no viewer," not "no tenant." The sole anonymous exception is the audio playback proxy (`GET /api/v1/audio`), which is capability-based: allowlisted content-addressed `blobs/` paths resolved to short-lived signed URLs.

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

Three limits are worth designing around before you write a client.

**Upload size and type.** `POST /api/v1/audio/upload` accepts a `multipart/form-data` body with a single `file` field, up to **25 MB**, and only these MIME types:

`audio/m4a` · `audio/x-m4a` · `audio/mp4` · `audio/mpeg` · `audio/webm` · `audio/ogg` · `audio/wav`

The match is exact, so strip any codec parameter first — `MediaRecorder` produces `audio/webm;codecs=opus`, which is rejected as-is. Anything outside the list, or over the cap, is a `400`.

:::note
The `dev.antiphony.embed.audio` lexicon permits `audio/*` up to 100 MB. That's the **record's** ceiling — what a portable record may legally describe. This endpoint is deliberately tighter; size your client to the numbers above, not to the lexicon.
:::

**Rate limits.** Every route carries one, keyed on the caller. Exceeding it returns `429`:

| Operation | Limit |
|---|---|
| Writes (`POST`/`PATCH /posts`) | 10 per 15 min |
| Reads (`GET /posts`, `/posts/{id}`, `/posts/{id}/replies`, `/audio`) | 60 per min |
| Uploads (`POST /audio/upload`) | 20 per hour |

The write limit is tight enough to hit while developing — back off rather than retrying immediately.

**Idempotency.** `POST /api/v1/posts` honours an `Idempotency-Key` header. Send a unique key per logical create and a retry after a timeout returns the original result instead of creating a second post. Recommended for any client that retries writes, since a network timeout can't tell you whether the post landed.

## Source of truth

The reference is generated at build time from the Zod request/response schemas declared in [`apps/core-api/src/adapters/inbound/rest/*.ts`](https://github.com/bbthorson/antiphony/tree/master/apps/core-api/src/adapters/inbound/rest). When a route's contract changes there, `npm run gen:openapi -w @antiphony/core-api` regenerates `openapi.json` and this site rebuilds. Those same schemas mirror the [lexicons](/lexicons/overview/), so the wire format and the portable records stay in lockstep.
