# @antiphony/core

> Open-core service layer for Antiphony. Portable business-logic classes — `AudioPostService`, `AudioProcessingService`, and the `makeStorageService` factory — plus the dependency **ports** they compose against.
>
> **License:** MIT. **Status:** consumed by `apps/core-api`.

## What lives here

- **`services/*.ts`** — service classes. Pure business logic; no vendor SDK imports, no framework imports, no I/O concerns. Today: `audio-posts.ts` (`AudioPostService` — posts, replies, hydrated views), `audio-processing.ts` (`AudioProcessingService` — the enrichment pipeline), `storage.ts` (`makeStorageService`).
- **`ports/*.ts`** — the narrow interface contracts the services depend on. Two kinds:
  - **Dependency ports** — the storage/query seam a service needs (`AudioPostDependencies`, `AudioProcessingDependencies`, `StorageDependencies`). A concrete backend implements these.
  - **Provider ports** — the pluggable capabilities enrichment uses: `TranscriberPort`, `DenoiserPort`, `TrimmerPort`, `WaveformPort`, `ProcessingDispatchPort`, `ProcessingNotifierPort`, plus `Logger`.

The package's hard constraint: **zero vendor SDK imports.** Service code is portable to any backend whose bindings implement the ports. Concrete adapters live in `apps/core-api/src/adapters/outbound/`.

## How it composes

```
packages/core/                     ← THIS PACKAGE (Vendor-free)
├── services/
│   ├── audio-posts.ts       — class AudioPostService (posts, replies, hydration)
│   ├── audio-processing.ts  — class AudioProcessingService (denoise/trim/transcribe/waveform)
│   └── storage.ts           — makeStorageService factory (BlobStore-backed)
└── ports/
    ├── audio-posts-dependencies.ts       — interface AudioPostDependencies
    ├── audio-processing-dependencies.ts  — interface AudioProcessingDependencies
    ├── storage-dependencies.ts           — interface StorageDependencies
    ├── transcription.ts / audio-denoiser.ts / audio-trimmer.ts /
    │   audio-waveform.ts / processing-dispatch.ts /
    │   processing-notifier.ts            — provider ports
    └── logger.ts
                ↑  each service takes its port via the constructor
                │
apps/core-api/src/adapters/outbound/    ← the driven adapters (Workers + Postgres + R2)
├── postgres/        — Postgres impl of AudioPostDependencies & AudioProcessingDependencies
├── r2/              — R2 BlobStore impl of StorageDependencies
├── durable-objects/ — RateLimitStore (Cloudflare Durable Objects)
├── elevenlabs/      — TranscriberPort + DenoiserPort
├── rendition/       — TrimmerPort + WaveformPort (HTTP to apps/audio-rendition)
├── dispatch/        — ProcessingDispatchPort (Cloudflare Queues / inline / noop)
└── webhook/         — ProcessingNotifierPort (HTTP webhook notifier)
```

A self-hoster targeting a different database or storage backend implements the `*Dependencies` ports against their stack and wires them where `apps/core-api` wires the Postgres/R2 ones; the domain logic keeps working without change.

## Rules

1. **No vendor SDK imports.** ESLint enforces. If a port pulls these in, the port isn't complete.
2. **No framework imports (Next.js, Hono, etc.).** This package is runtime-agnostic and builds standalone for arbitrary JavaScript/TypeScript environments (Node, Workers, Edge).
3. **Services stay independent.** Each takes its own dependency port via the constructor — no service imports another service's concrete class. Genuinely shared *pure* helpers (e.g. `buildPostUri`) are imported directly as functions, not reached through a service.
4. **Shared types stay in [`@antiphony/shared`](../shared/).** Don't duplicate them here.

## Publishing

`@antiphony/core` is currently `private` — no npm release yet. The companion [`@antiphony/shared`](../shared/) (types + Zod schemas) **is** published. The MIT `LICENSE` in the repository root applies.

