---
title: Architecture
description: How Vox Pop Core is wired internally.
---

Vox Pop Core is a ports-and-adapters (hexagonal) service. HTTP comes in through inbound adapters, business logic lives in services that depend only on small interfaces, and a composition root wires concrete implementations of those interfaces. The point of the shape: **the backend is a swap point, not a hard dependency.**

Firebase (Firestore, Firebase Auth, Cloud Storage) is the only backend implemented today, so the shipped composition root is Firebase-backed. Keeping that behind adapter interfaces is deliberate — **generalizing the core so it isn't tied to Firebase is active work**, and this layering is what makes that tractable.

## The 30-second version

```
┌─────────────────────────────────────────────────────┐
│                   apps/core-api/                      │
│                                                       │
│   adapters/inbound/rest/*.ts                          │
│   ← Hono handlers + Zod request/response schemas      │
│        │                                              │
│        ▼                                              │
│   use-cases/*.ts        (application logic)           │
│        │                                              │
│        ▼                                              │
│   packages/core/services/*.ts                         │
│   ← pure-TS services (UserService, PromptService,     │
│     ReplyService, FeedService, …) over *Dependencies  │
│     interfaces — no Firebase import                   │
│        ▲                                              │
│        │ implements                                   │
│   adapters/outbound/firebase/*.ts                     │
│   ← composition root: Firebase-backed implementations │
└─────────────────────────────────────────────────────┘
```

## The layers

- **Inbound adapters** (`apps/core-api/src/adapters/inbound/rest/`) own HTTP. Each route file validates with Zod, authenticates via the bearer middleware, and delegates. Routes mount under `/api/v1/*` in `apps/core-api/src/app.ts` — that file is the single registry of the public surface (`prompts`, `replies`, `users`, `audio`, `rss`, `organizations`, `atproto`, …).
- **Use cases** (`apps/core-api/src/use-cases/`) hold application-level orchestration — the steps a request triggers, independent of transport.
- **Services** (`packages/core/services/`) hold domain logic. They depend on small `*Dependencies` interfaces (a data port, a clock, an ID generator), **never on `firebase-admin` directly**. This is the package you reuse or test in isolation.
- **Outbound adapters / composition root** (`apps/core-api/src/adapters/outbound/firebase/`) implement those `*Dependencies` interfaces against Firestore, Firebase Auth, and Cloud Storage, and assemble the wired services that the routes import.

## The seam that matters

Because services depend on interfaces and the composition root supplies the implementations, the backend is a single swap point:

- **Tests** inject in-memory implementations of `*Dependencies` — no emulator needed for unit tests of `packages/core`.
- **A different backend** (Postgres, SQLite, an HTTP upstream) means writing one new outbound adapter set and pointing the composition root at it. `packages/core/services/` and every route file stay untouched.

If you're building your own app *on top of* the API, you don't need any of this — you talk to `/api/v1/*` over HTTP (see [Build your own app](/build-your-own/overview/)). This layering matters when you're **extending or re-backing the core itself**.

## Where the AT Protocol fits

Identity interop is part of the open core but deliberately split. The record→lexicon transform is pure and lives in `packages/core/services/atproto-lexicon.ts`; the PDS I/O and OAuth client (the publishing side) live in the hosted layer. The [`lexicons/` README](https://github.com/bbthorson/vox-pop-core/blob/main/lexicons/README.md) documents both the lexicon shapes and that seam.

## Where next?

- [Build your own app](/build-your-own/overview/) — consume the API from your own surface.
- [Configuration](/self-hosting/configuration/) — the env vars and deploy targets for the composition root.
- [API reference](/api/overview/) — the contract the inbound adapters expose.
