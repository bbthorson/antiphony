# @vox-pop/shared

> Open-core type definitions and validation codecs shared across every tier — `apps/core-api`, `apps/web`, `apps/mobile`, `functions/`, and any future binding (Postgres, in-memory).
>
> **License:** MIT. **Status:** Stable; ships as part of the open-core surface.

## What lives here

### `types/records.ts`
Raw Firestore (or equivalent backend) schemas. The shape of stored data, before any view-layer hydration.

```ts
// PromptRecord example
{
  id: 'p_abc',
  authorId: 'u_123',
  title: 'Hello',
  audioUrl: '...',
  createdAt: new Date('2026-04-25T12:00:00Z'),
  status: 'live',
}
```

### `types/views.ts`
Hydrated API-response schemas. A `View` always carries its underlying `Record` plus author/recipient/computed-field hydration.

```ts
// PromptView example
{
  record: { /* PromptRecord */ },
  author: { id, handle, displayName, avatarUrl, ... },
  replyCount: 12,
  visibility: 'public',
}
```

### `api-codecs.ts`
Zod request schemas for write endpoints — `CreatePromptRequestSchema`, `UpdateOrgRequestSchema`, etc. Single source of truth for write-payload validation; consumed by both core-api route handlers and apps/web client code so the request shape can't drift.

### `nsid.ts`
AT Protocol Namespaced Identifiers (`com.voxpop.audio.prompt`, `com.voxpop.actor.profile`, `com.voxpop.audio.reply`) plus the NSID-to-Firestore-collection mapping. Used by Phase 4c lexicon publishing (see [`specs/4c-atproto-prompts.md`](../../specs/4c-atproto-prompts.md)).

### `errors.ts`
Typed `ServiceError` subclasses (`NotFoundError`, `ForbiddenError`, `ConflictError`). Throw from service code; the error-handler middleware in core-api maps them to HTTP statuses automatically.

### `utils/`
Pure utility functions — projection helpers (`toReplyViewPublic`, `toProfileViewBasic`), date/string/sanitization helpers. No I/O, no Firebase imports.

## Rules

1. **Zero runtime dependencies on Firebase, Next.js, Hono, or React.** Every tier imports `@vox-pop/shared`; cross-tier imports must be portable.
2. **Records vs. Views vs. Codecs are NOT interchangeable.** Stored shape, response shape, and request shape have different lifecycles — keep them in distinct files even when they look similar.
3. **Schema changes are a contract change.** When `PromptRecord` gets a new field, every binding has to handle it. Use `.optional()` / `.default()` aggressively for forward compatibility; widening is cheaper than narrowing later.

## Phase 4b — open-source split

This package is destined for [github.com/bbthorson/vox-pop-core](https://github.com/bbthorson/vox-pop-core) via `git subtree split` once the carve-out runs. See [`docs/4b-carveout-runbook.md`](../../docs/4b-carveout-runbook.md). The MIT `LICENSE` file in this directory travels with the split.
