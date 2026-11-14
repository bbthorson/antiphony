# @antiphony/core

> Open-core service layer for Antiphony: portable business logic (posts, enrichment, spaces, remote posts, deletion, the DID registry, tenant stats) plus the dependency **ports** it composes against.
>
> **License:** MIT. **Status:** consumed by `apps/core-api`.

## What lives here

- **`services/*.ts`**: pure business logic, with no vendor SDK imports, no framework imports and no I/O.

  | Service | What it does |
  | :--- | :--- |
  | `audio-posts.ts` | Posts and replies Antiphony holds, hydrated views, and building and parsing record URIs (flat and in a space) |
  | `audio-processing.ts` | The enrichment pipeline: denoise, trim, transcribe, waveform |
  | `spaces.ts` | A tenant's atproto spaces and their policies |
  | `remote-posts.ts` | Audio whose record lives in another repo: registration, verification, rechecks |
  | `post-deletion.ts` | Deleting posts and their audio, and the deletion ledger |
  | `did-registry.ts` | DIDs a tenant may write under besides its app DID |
  | `tenant-stats.ts` | Post counts for the calling tenant |
  | `storage.ts` | `makeStorageService`, over a `BlobStore` |

- **`ports/*.ts`**: the narrow interfaces the services depend on. Two kinds:
  - **Dependency ports**: the storage and query seam each service needs (`AudioPostDependencies`, `RemotePostDependencies`, `SpaceDependencies`, …). A concrete backend implements them.
  - **Provider ports**: pluggable capabilities. Enrichment uses `TranscriberPort`, `DenoiserPort`, `TrimmerPort`, `WaveformPort`, `ProcessingDispatchPort` and `ProcessingNotifierPort`. Remote posts use `PublicRepoPort` and `SpaceRepoPort` (reading records and blobs from other repos) and `RemoteNotifierPort`. Deletion uses `DeletionNotifierPort`. Everything takes a `Logger`.

The package's hard constraint: **zero vendor SDK imports.** Service code is portable to any backend whose bindings implement the ports. Concrete adapters live in `apps/core-api/src/adapters/outbound/`.

## How it composes

```
packages/core/                          ← THIS PACKAGE (vendor-free)
├── services/   — the services above
├── ports/      — *-dependencies.ts (storage seams) and provider ports
└── testing/    — an in-memory AudioPostDependencies and the contract suite adapters run
                ↑  each service takes its ports through its constructor
                │
apps/core-api/src/adapters/outbound/    ← the driven adapters (Workers + Postgres + R2)
├── postgres/        — every *Dependencies port, plus idempotency, rate limits and the sweeps
├── r2/              — the BlobStore behind StorageDependencies
├── atproto/         — PublicRepoPort and SpaceRepoPort (DID documents, repos, spaces)
├── durable-objects/ — the rate-limit store
├── elevenlabs/      — TranscriberPort and DenoiserPort
├── workers-ai/      — a TranscriberPort on the Workers AI binding
├── rendition/       — TrimmerPort and WaveformPort, over HTTP to apps/audio-rendition
├── processing/      — the provider registry that picks among them
├── dispatch/        — ProcessingDispatchPort (Cloudflare Queues, inline, or no-op)
└── webhook/         — the notifier ports, as signed webhooks to tenant BFFs
```

A self-hoster targeting a different database or storage backend implements the `*Dependencies` ports against their stack and wires them where `apps/core-api` wires the Postgres/R2 ones; the domain logic keeps working without change.

## Rules

1. **No vendor SDK imports.** ESLint enforces. If a port pulls these in, the port isn't complete.
2. **No framework imports (Next.js, Hono, etc.).** This package is runtime-agnostic and builds standalone for arbitrary JavaScript/TypeScript environments (Node, Workers, Edge).
3. **Services stay independent.** Each takes its own dependency port via the constructor — no service imports another service's concrete class. Genuinely shared *pure* helpers (e.g. `buildPostUri`) are imported directly as functions, not reached through a service.
4. **Shared types stay in [`@antiphony/shared`](../shared/).** Don't duplicate them here.

## Publishing

`@antiphony/core` is currently `private` — no npm release yet. The companion [`@antiphony/shared`](../shared/) (types + Zod schemas) **is** published. The MIT `LICENSE` in the repository root applies.

