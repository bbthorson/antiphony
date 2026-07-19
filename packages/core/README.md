# @antiphony/core

> Open-core service layer for Antiphony. Portable business-logic classes — `AudioPostService`, `AudioProcessingService`, `UserService`, and the `makeStorageService` factory — plus the dependency **ports** they compose against.
>
> **License:** MIT. **Status:** consumed by `apps/core-api`.

## What lives here

- **`services/*.ts`** — service classes. Pure business logic; no Firebase imports, no Next.js imports, no I/O concerns. Today: `audio-posts.ts` (`AudioPostService` — posts, replies, hydrated views), `audio-processing.ts` (`AudioProcessingService` — the enrichment pipeline), `users.ts` (`UserService`), `storage.ts` (`makeStorageService`).
- **`ports/*.ts`** — the narrow interface contracts the services depend on. Two kinds:
  - **Dependency ports** — the storage/query seam a service needs (`AudioPostDependencies`, `AudioProcessingDependencies`, `UserDependencies`, `StorageDependencies`). A backend implements these.
  - **Provider ports** — the pluggable capabilities enrichment uses: `TranscriberPort`, `DenoiserPort`, `TrimmerPort`, `WaveformPort`, `ProcessingDispatchPort`, plus `AuthPort` and `Logger`.

The package's hard constraint: **zero `firebase` / `firebase-admin` imports.** Service code is portable to any backend whose bindings implement the ports. The Firebase-flavored implementation is in `apps/core-api`; a hypothetical Postgres-backed implementation would live elsewhere.

## How it composes

```
packages/core/                     ← THIS PACKAGE (Firebase-free)
├── services/
│   ├── audio-posts.ts       — class AudioPostService (posts, replies, hydration)
│   ├── audio-processing.ts  — class AudioProcessingService (denoise/trim/transcribe/waveform)
│   ├── users.ts             — class UserService
│   └── storage.ts           — makeStorageService factory (BlobStore-backed)
└── ports/
    ├── audio-posts-dependencies.ts       — interface AudioPostDependencies
    ├── audio-processing-dependencies.ts  — interface AudioProcessingDependencies
    ├── users-dependencies.ts             — interface UserDependencies
    ├── storage-dependencies.ts           — interface StorageDependencies
    ├── transcription.ts / audio-denoiser.ts / audio-trimmer.ts /
    │   audio-waveform.ts / processing-dispatch.ts   — provider ports
    └── auth-port.ts / logger.ts
                ↑  each service takes its port via the constructor
                │
apps/core-api/src/adapters/outbound/    ← the driven adapters (Firebase, etc.)
├── firebase/audio-posts-dependencies.ts        ← Firebase impl of AudioPostDependencies
├── firebase/audio-processing-dependencies.ts   ← …of AudioProcessingDependencies
├── firebase/users-dependencies.ts / storage-dependencies.ts
├── elevenlabs/  — TranscriberPort + DenoiserPort
├── ffmpeg/      — TrimmerPort + WaveformPort
└── dispatch/    — ProcessingDispatchPort (inline / noop / cloud-tasks)
```

A self-hoster who wants Postgres support implements the `*Dependencies` ports against their stack and wires them where `apps/core-api` wires the Firebase ones; the rest of the code keeps working.

## Rules

1. **No `firebase` / `firebase-admin` imports.** ESLint enforces. If a port pulls these in, the port isn't complete.
2. **No Next.js imports.** This package builds standalone for arbitrary Node runtimes.
3. **Services stay independent.** Each takes its own dependency port via the constructor — no service imports another service's concrete class. Genuinely shared *pure* helpers (e.g. `buildPostUri`) are imported directly as functions, not reached through a service.
4. **Shared types stay in [`@antiphony/shared`](../shared/).** Don't duplicate them here.

## Publishing

`@antiphony/core` is currently `private` — no npm release yet. The companion [`@antiphony/shared`](../shared/) (types + Zod schemas) **is** published. The MIT `LICENSE` in this directory ships with any future release.
