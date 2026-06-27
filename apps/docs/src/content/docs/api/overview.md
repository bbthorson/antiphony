---
title: API reference
description: The /api/v1/* endpoints exposed by Vox Pop Core.
---

The full per-endpoint reference lives at **[/api/reference](/api/reference/)** — a Scalar-rendered view of the live OpenAPI spec generated from `apps/core-api`'s Zod schemas.

This page covers the high-level shape of the surface and the auth + envelope conventions every endpoint follows.

## What's covered

Every endpoint in the reference lives in **`apps/core-api`** — the open-core service. Apps built on the core may add their own product-specific endpoints on top; those aren't part of this open core and aren't documented here.

Public scope (the four core resources):

- **`/users`** — Profile read, current-user write, organization memberships, handle claim/availability.
- **`/prompts`** — Prompt CRUD, status lifecycle, replies-on-prompt, legacy public-prompt lookup.
- **`/replies`** — Reply CRUD, paginated feed, full-text search, notes, bulk actions.
- **`/auth`** — AT Protocol identity disconnect.

Internal/utility routes (audio transport, RSS parsing, handle resolution, system-auth glue) intentionally stay out of the public reference — they're either origin-coupled or service-to-service plumbing a third-party client wouldn't call.

## Authentication

All non-public endpoints require a bearer token in the `Authorization` header:

```
Authorization: Bearer <id_token_or_session_cookie>
```

`core-api` accepts both Firebase ID tokens (mobile, embed, browser) and Firebase session cookie values (server-side rendered apps) interchangeably. See [`apps/core-api/src/middleware/auth.ts`](https://github.com/bbthorson/vox-pop-core/blob/main/apps/core-api/src/middleware/auth.ts) for the verification logic.

Public endpoints accept missing/invalid tokens and project the response to a public-safe shape.

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

The `requestId` correlation ID appears in every error response and as the `X-Request-ID` response header on every request — propagate it from your client (`X-Request-ID: <uuid>`) for end-to-end tracing across `core-api`, the hosted dashboard, and Cloud Functions logs.

## Source of truth

The reference is generated at build time from the Zod request/response schemas declared in [`apps/core-api/src/adapters/inbound/rest/*.ts`](https://github.com/bbthorson/vox-pop-core/tree/main/apps/core-api/src/adapters/inbound/rest). When a route's contract changes there, `npm run gen:openapi -w @vox-pop/core-api` regenerates `openapi.json` and this site rebuilds.
