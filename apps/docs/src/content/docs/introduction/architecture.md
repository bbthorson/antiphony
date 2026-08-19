---
title: Architecture
description: How Antiphony's core is wired internally.
---

Antiphony's core is a ports-and-adapters (hexagonal) service. HTTP comes in through inbound adapters, business logic lives in services that depend only on small interfaces, and a composition root wires concrete implementations of those interfaces. The point of the shape: **the backend is a swap point, not a hard dependency.**

That claim has now been paid for. The reference deployment moved its entire backend — Firestore to **Neon Postgres**, Cloud Storage to **Cloudflare R2**, Cloud Tasks to **Cloudflare Queues**, and Cloud Run to **Cloudflare Workers** — without a single change to `packages/core` or to any route handler. What moved was one set of outbound adapters and the composition root that picks between them.

## The 30-second version

```
┌─────────────────────────────────────────────────────┐
│                   apps/core-api/                      │
│                                                       │
│   middleware/auth.ts, service-auth.ts                 │
│   ← app service credential → tenancy + acting actor    │
│        │                                              │
│        ▼                                              │
│   adapters/inbound/rest/*.ts                          │
│   ← Hono handlers + Zod request/response schemas      │
│        │                                              │
│        ▼                                              │
│   packages/core/services/*.ts                         │
│   ← pure-TS services (AudioPostService,               │
│     AudioProcessingService, StorageService, …) over   │
│     *Dependencies interfaces — no backend import       │
│        ▲                                              │
│        │ implements                                   │
│   adapters/outbound/{postgres,r2,durable-objects,     │
│                      dispatch,elevenlabs,rendition}/  │
│   ← composition root: the bindings behind the ports   │
└─────────────────────────────────────────────────────┘
```

## The layers

- **Auth middleware** (`apps/core-api/src/middleware/auth.ts`, `service-auth.ts`) resolves the caller from its **service credential** — the only credential the core accepts. The token yields the tenancy; the acting end user arrives as a per-request assertion alongside it. There is no end-user token path. See [API reference § Authentication](/api/overview/#authentication) and [`specs/service-auth.md`](https://github.com/bbthorson/antiphony/blob/master/specs/service-auth.md).
- **Inbound adapters** (`apps/core-api/src/adapters/inbound/rest/`) own HTTP. Each route file validates with Zod, authenticates via the bearer middleware, and delegates. Routes mount under `/api/v1/*` in `apps/core-api/src/app.ts` — that file is the single registry of the public surface, which is `posts` and `audio` (plus the system-auth'd `/api/v1/system/*` plumbing). See [API reference](/api/overview/#whats-covered).
- **Services** (`packages/core/services/`) hold domain logic. They depend on small `*Dependencies` interfaces (a data port, a clock, an ID generator), **never on a vendor SDK directly** — lint-enforced. This is the package you reuse or test in isolation. (`apps/core-api/src/use-cases/` is a reserved layer for cross-service orchestration — currently empty; most routes call a service directly.)
- **Outbound adapters** (`apps/core-api/src/adapters/outbound/`) implement those `*Dependencies` interfaces against concrete infrastructure — `postgres/` (records, transcripts, processing state, idempotency), `r2/` (audio blobs and their derived renditions), `durable-objects/` (rate-limit buckets), `dispatch/` (the processing queue), `elevenlabs/` (denoise + transcribe), and `rendition/` (the ffmpeg stages, over HTTP).
- **The composition root** (`apps/core-api/src/composition.ts`) is the one module that decides which adapter backs which port. It reads the bindings off the runtime environment rather than constructing singletons at module load — a Worker receives its bindings on the `env` argument to `fetch`, so they do not exist at import time.

## The seam that matters

Because services depend on interfaces and the composition root supplies the implementations, the backend is a single swap point:

- **Tests** inject in-memory implementations of `*Dependencies` — no database and no emulator needed for unit tests of `packages/core`.
- **A different backend** (another Postgres, SQLite, an HTTP upstream) means writing one new outbound adapter set and pointing the composition root at it. `packages/core/services/` and every route file stay untouched.

The reference deployment is the worked example. Swapping Firestore for Postgres and Cloud Storage for R2 touched the adapter directory and `composition.ts`; the four `*Dependencies` interfaces, every service, and every route file were unchanged by it.

If you're building your own app *on top of* the API, you don't need any of this — you talk to `/api/v1/*` over HTTP (see [Build your own app](/build-your-own/overview/)). This layering matters when you're **extending or re-backing the core itself**.

## What the reference deployment runs on

`api.antiphony.dev` is one Cloudflare Worker. Nothing below is a requirement of the core — it's what the ports are wired to on this particular deployment, and it's the concrete example to read the adapter directory against.

| Concern | Binding | Port it implements |
|---|---|---|
| Post records, transcripts, processing state, idempotency keys | **Neon Postgres** (`DATABASE_URL`, a Worker secret) | `AudioPostDependencies`, `AudioProcessingDependencies`, `IdempotencyStore` |
| Audio blobs and derived renditions | **R2** (`BLOBS`), at `blobs/{originAppId}/{cid}` and `renditions/{originAppId}/{cid}.{format}` | `BlobStore` |
| Enrichment dispatch | **Cloudflare Queues** (`PROCESSING_QUEUE`) — producer and consumer are the same Worker | `ProcessingDispatch` |
| Rate-limit buckets | **A Durable Object** (`RATE_LIMITER`), one per bucket key | `RateLimitStore` |
| App-DID custody cache | **KV** (`PIN_CACHE`) | — |
| Expiry sweep | **A Cron Trigger**, hourly | — |

Two things about that table are worth more than the table itself:

- **Every binding is authorised by being bound.** There is no R2 key, no service-account JSON, and no connection string in the checked-in config — the database URL is the single secret, and it's one only because the SQL driver speaks HTTP to Neon rather than reaching a binding.
- **`rate_limits` is the one place Postgres was the wrong tool.** It's a high-frequency counter write sitting on the read path, so a round trip to a single-region database would be paid by every rate-limited request. Per-key strongly-consistent counters are what Durable Objects are for.

### The one service that is not a Worker

`trim` and `waveform` shell out to ffmpeg, and no Workers runtime can spawn a subprocess. Those two stages — and on-demand mp3 renditions for the audio proxy — run in [`apps/audio-rendition`](https://github.com/bbthorson/antiphony/tree/master/apps/audio-rendition), a small container on Cloud Run that reads and writes the same R2 bucket. The core reaches it over HTTP with a system token, so from the ports' point of view it is just another adapter, and a deployment without one resolves both stages unavailable rather than failing posts.

## Multi-tenancy

One Antiphony deployment can serve more than one app. The tenancy boundary is the **origin app**: every post is stamped with an `originAppId`, and reads are scoped to the same key — so App A never sees App B's posts by default. The tenancy key is derived from the caller's service credential and **only** from there (see [Authentication](/api/overview/#authentication)) — there is no deployment-level default, because inferring a tenant from config would let an untrusted request read an arbitrary tenant's data. Sharing across apps is **directional and explicit**, resolved at the read (AppView) layer rather than baked into the record.

Each tenant also carries a pinned **app DID** — the `at://` authority its records are written under, proven before any handler runs. See [Tenant identity](/self-hosting/configuration/#tenant-identity).

`orgId`, where it appears, is *not* a tenancy boundary — it's an opaque indexed facet an app may tag records with for its own grouping. The core stores and filters by it but never defines what an "org" is; teams, membership, and billing are app-layer concerns. (See [What is Antiphony?](/introduction/overview/#whats-intentionally-not-in-the-open-core).)

## Where the AT Protocol fits

Identity interop and the record shapes are the heart of the open core. The lexicons live as JSON under [`lexicons/dev/antiphony/`](https://github.com/bbthorson/antiphony/tree/master/lexicons/dev/antiphony) and are mirrored by the Zod schemas in `packages/shared`. The record→lexicon transform is pure and lives in `packages/core/services/`; PDS I/O and the OAuth client (the publishing side) live in the hosted layer. See [The Antiphony lexicons](/lexicons/overview/) for the contract itself.

## Where next?

- [The Antiphony lexicons](/lexicons/overview/) — the canonical record contract.
- [Build your own app](/build-your-own/overview/) — consume the API from your own surface.
- [Configuration](/self-hosting/configuration/) — the env vars and deploy targets for the composition root.
- [API reference](/api/overview/) — the contract the inbound adapters expose.
