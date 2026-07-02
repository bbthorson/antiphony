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
- **`/audio`** — Upload audio (content-addressed — see [Lexicons § How faithful is this to AT Protocol?](/lexicons/overview/#how-faithful-is-this-to-at-protocol)), and resolve a stored ref to a short-lived signed playback URL.
- **`/actors`** — The optional actor↔DID mapping a connecting app may register (`POST /actors/register`, `GET /actors/:actorId`). This is narrow: just the AT Protocol identity, not a profile. See [service auth](#authentication) below.

:::note[Legacy surface — not the target contract]
`/users`, `/atproto`, and `/resolve` are still live on this deployment but are **Vox Pop's profile/identity-linking surface**, not part of Antiphony's core contract. Antiphony is infrastructure for storing and retrieving audio posts; end-user profile data (display name, bio, handle claiming, OAuth linking UX) belongs to the calling application, not the core. These routes stay until that app finishes moving its own profile store — don't build a new integration against them; use `/posts`, `/audio`, and `/actors`.
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

Antiphony is meant to be called by an **application** (a BFF, a worker), not directly by end-user browsers. All non-public endpoints require a bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Two ways to authenticate, resolved in this order:

1. **Service credential (the intended path).** Your app authenticates with its own service token (`ANTIPHONY_APP_TOKENS` — provisioned by whoever runs the deployment) and asserts which of *its* users is acting:

   ```
   Authorization: Bearer <your-app-service-token>
   X-Antiphony-Acting-Actor: <your-internal-user-id>
   X-Antiphony-Acting-Actor-Did: <their-at-protocol-did>   # optional
   ```

   Your app's tenancy (`originAppId`) is derived from the token — Antiphony never sees your end users' credentials, and you never see Antiphony's. Full contract: [`specs/service-auth.md`](https://github.com/bbthorson/antiphony/blob/master/specs/service-auth.md).

2. **Firebase end-user token (demo / this deployment's reference app only).** A Firebase ID token or session cookie, verified directly against this deployment's Firebase project. This is how [`apps/reference`](/build-your-own/reference-app/) works — a browser demo has nowhere to hold a service secret — but it couples the caller to this specific Firebase project, so it isn't the integration path for a real application.

Public projections (e.g. `GET /posts/:id`) accept missing/invalid tokens and return a public-safe shape.

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

The reference is generated at build time from the Zod request/response schemas declared in [`apps/core-api/src/adapters/inbound/rest/*.ts`](https://github.com/bbthorson/antiphony/tree/master/apps/core-api/src/adapters/inbound/rest). When a route's contract changes there, `npm run gen:openapi -w @antiphony/core-api` regenerates `openapi.json` and this site rebuilds. Those same schemas mirror the [lexicons](/lexicons/overview/), so the wire format and the portable records stay in lockstep.
