---
title: Architecture
description: How Antiphony's core is wired internally.
---

Antiphony's core is a ports-and-adapters (hexagonal) service. HTTP comes in through inbound adapters, business logic lives in services that depend only on small interfaces, and a composition root wires concrete implementations of those interfaces. The point of the shape: **the backend is a swap point, not a hard dependency.**

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
│   ← pure-TS services (PostService, AudioService,      │
│     ActorService, FeedService, …) over *Dependencies  │
│     interfaces — no Firebase import                   │
│        ▲                                              │
│        │ implements                                   │
│   adapters/outbound/firebase/*.ts                     │
│   ← composition root: Firebase-backed implementations │
└─────────────────────────────────────────────────────┘
```

## The layers

- **Inbound adapters** (`apps/core-api/src/adapters/inbound/rest/`) own HTTP. Each route file validates with Zod, authenticates via the bearer middleware, and delegates. Routes mount under `/api/v1/*` in `apps/core-api/src/app.ts` — that file is the single registry of the public surface (`posts`, `audio`, `users`, `atproto`, `resolve`, …).
- **Use cases** (`apps/core-api/src/use-cases/`) hold application-level orchestration — the steps a request triggers, independent of transport.
- **Services** (`packages/core/services/`) hold domain logic. They depend on small `*Dependencies` interfaces (a data port, a clock, an ID generator), **never on `firebase-admin` directly**. This is the package you reuse or test in isolation.
- **Outbound adapters / composition root** (`apps/core-api/src/adapters/outbound/firebase/`) implement those `*Dependencies` interfaces against Firestore, Firebase Auth, and Cloud Storage, and assemble the wired services that the routes import.

## The seam that matters

Because services depend on interfaces and the composition root supplies the implementations, the backend is a single swap point:

- **Tests** inject in-memory implementations of `*Dependencies` — no emulator needed for unit tests of `packages/core`.
- **A different backend** (Postgres, SQLite, an HTTP upstream) means writing one new outbound adapter set and pointing the composition root at it. `packages/core/services/` and every route file stay untouched.

If you're building your own app *on top of* the API, you don't need any of this — you talk to `/api/v1/*` over HTTP (see [Build your own app](/build-your-own/overview/)). This layering matters when you're **extending or re-backing the core itself**.

## Multi-tenancy

One Antiphony deployment can serve more than one app. The tenancy boundary is the **origin app**: every post is stamped with an `originAppId` (server-side, from the deployment's `ANTIPHONY_ORIGIN_APP_ID`), and reads are scoped to the same key — so App A never sees App B's posts by default. Sharing across apps is **directional and explicit**, resolved at the read (AppView) layer rather than baked into the record.

`orgId`, where it appears, is *not* a tenancy boundary — it's an opaque indexed facet an app may tag records with for its own grouping. The core stores and filters by it but never defines what an "org" is; teams, membership, and billing are app-layer concerns. (See [What is Antiphony?](/introduction/overview/#whats-intentionally-not-in-the-open-core).)

## Where the AT Protocol fits

Identity interop and the record shapes are the heart of the open core. The lexicons live as JSON under [`lexicons/dev/antiphony/`](https://github.com/bbthorson/antiphony/tree/main/lexicons/dev/antiphony) and are mirrored by the Zod schemas in `packages/shared`. The record→lexicon transform is pure and lives in `packages/core/services/`; PDS I/O and the OAuth client (the publishing side) live in the hosted layer. See [The Antiphony lexicons](/lexicons/overview/) for the contract itself.

## Where next?

- [The Antiphony lexicons](/lexicons/overview/) — the canonical record contract.
- [Build your own app](/build-your-own/overview/) — consume the API from your own surface.
- [Configuration](/self-hosting/configuration/) — the env vars and deploy targets for the composition root.
- [API reference](/api/overview/) — the contract the inbound adapters expose.
