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

- **`/posts`** — Create an audio post, get one by id, list the viewer's posts, list a post's replies (the thread). One record type; `reply` presence is prompt-vs-reply.
- **`/audio`** — Upload audio (authenticated and anonymous-pending), and resolve a stored ref to a short-lived signed playback URL.
- **`/users`** — Profile read, current-user write, handle claim/availability.
- **`/actors`** / **`/resolve`** — Actor profiles and handle resolution.
- **`/atproto`** — AT Protocol identity linking (connect/disconnect — about the actor's DID).

:::note
Some routes still present on a given deployment (legacy `prompts`/`replies`, app-level grouping) are **app-layer carryover**, not part of the canonical Antiphony contract. The records above — and the [lexicons](/lexicons/overview/) — are what an adopter builds against.
:::

Internal/utility routes (system-auth glue, ingestion plumbing) intentionally stay out of the public reference — they're service-to-service plumbing a third-party client wouldn't call.

## Reply gating

Replies are **not** an open comment thread — the AppView enforces who may reply, and clients should reflect that:

- **Replying to a prompt** is open to any authenticated viewer (the app's default audience policy).
- **Replying to a reply** is restricted to that branch's **two participants** — the prompt's author (the creator) and the responder who opened the branch. Anyone else gets a `403`.

So each top-level reply is a private creator ↔ responder back-and-forth no third party can join. The rule is enforced on **write** (`POST /api/v1/posts` rejects a disallowed reply) and surfaced on **read**, so you don't have to reimplement it: every `AudioPostView` carries a `viewer` block with

- **`canReply`** — whether the current caller may reply to this post, and
- **`replyDisabledReason`** — `unauthenticated` or `not_a_participant` when they can't.

Drive your reply affordance off `viewer.canReply`. (An app that wants different rules — open public threads, say — is a future `app.bsky.feed.threadgate` override; participant-only is the default.)

## Authentication

All non-public endpoints require a bearer token in the `Authorization` header:

```
Authorization: Bearer <id_token_or_session_cookie>
```

`core-api` accepts both Firebase ID tokens (mobile, embed, browser) and Firebase session cookie values (server-side rendered apps) interchangeably. An **anonymous** Firebase token is enough to write and read your own posts — see the [reference app](/build-your-own/reference-app/). Public projections accept missing/invalid tokens and return a public-safe shape.

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

## Source of truth

The reference is generated at build time from the Zod request/response schemas declared in [`apps/core-api/src/adapters/inbound/rest/*.ts`](https://github.com/bbthorson/antiphony/tree/main/apps/core-api/src/adapters/inbound/rest). When a route's contract changes there, `npm run gen:openapi -w @antiphony/core-api` regenerates `openapi.json` and this site rebuilds. Those same schemas mirror the [lexicons](/lexicons/overview/), so the wire format and the portable records stay in lockstep.
