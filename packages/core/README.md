# @antiphony/core

> Open-core service layer for Antiphony. Portable business-logic classes (`PostService`, `UserService`, `HydrationService`, `FeedService`, `StorageService`, plus the legacy `PromptService`/`ReplyService`/`OrganizationService` on the Stream-4 retirement path) plus their dependency contracts.
>
> **License:** MIT. **Status:** consumed by `apps/core-api`.

## What lives here

- **`services/*.ts`** — service classes. Pure business logic; no Firebase imports, no Next.js imports, no I/O concerns.
- **`services/*-dependencies.ts`** — narrow interface contracts each service depends on (`UserDependencies`, `PromptDependencies`, etc.). The Firebase-backed implementations live in `apps/core-api/src/services/*-dependencies.ts`; self-hosters write their own bindings against these contracts.
- **`services/core-services.ts`** — the `CoreServices` aggregate (the Phase 2.5 DI container) — the way services reach each other without importing concrete singletons.

The package's hard constraint: **zero `firebase` / `firebase-admin` imports.** Service code is portable to any backend whose binding implements the dependency contracts. The `firebase`-flavored implementation is in `apps/core-api`; a hypothetical Postgres-backed implementation would live elsewhere.

## How it composes

```
apps/core-api/src/services/
├── core-services-firebase.ts    ← imports services from packages/core, wires
│                                  Firebase-backed *-dependencies bindings
├── users-dependencies.ts        ← Firebase impl of UserDependencies
├── prompts-dependencies.ts      ← Firebase impl of PromptDependencies
├── replies-dependencies.ts      ← Firebase impl of ReplyDependencies
├── organizations-dependencies.ts
├── hydration-dependencies.ts
└── storage-dependencies.ts
                ↑
                │
packages/core/services/  ← THIS PACKAGE
├── users.ts             — class UserService, depends on UserDependencies
├── prompts.ts           — class PromptService
├── replies.ts           — class ReplyService
├── organizations.ts     — class OrganizationService
├── hydration.ts         — class HydrationService (view-builder)
├── feeds.ts             — class FeedService (read-side aggregations)
├── rss.ts               — class RssService (URL-fetch RSS parser)
├── storage.ts           — makeStorageService factory (BlobStore-backed)
├── prompts-dependencies.ts    — interface PromptDependencies
├── ...                        — narrow contracts, one per service
└── core-services.ts     — interface CoreServices (DI aggregate)
```

A self-hoster who wants Postgres support implements all the `*-dependencies.ts` interfaces against their stack, mirrors the `core-services-firebase.ts` composition root, and the rest of the code keeps working.

## Rules

1. **No `firebase` / `firebase-admin` imports.** ESLint enforces. If a port pulls these in, the port isn't complete.
2. **No Next.js imports.** This package builds standalone for arbitrary Node runtimes.
3. **Cross-service calls go through `CoreServices`.** Don't import another service's concrete class; reach via `this.services.users.*` etc. See [`specs/decoupling-migration.md`](../../specs/decoupling-migration.md) § Phase 2.5 for the rationale.
4. **Shared types stay in [`@antiphony/shared`](../shared/).** Don't duplicate them here.

## Publishing

`@antiphony/core` is currently `private` — no npm release yet. It gains substance alongside the canonical `dev.antiphony.audio.post` services before it's published; the companion [`@antiphony/shared`](../shared/) (types + Zod schemas) **is** published. The MIT `LICENSE` in this directory ships with any future release.
