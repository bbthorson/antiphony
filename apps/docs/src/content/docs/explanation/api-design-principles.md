---
title: API design principles
description: The four rules that keep the core's contract small, stable, and open — and how to tell what belongs in the core versus a connector.
---

The consumer API is deliberately small, and it stays that way because every endpoint obeys the same handful of rules. This page is those rules, written down. Read it if you're **extending the core** (deciding whether a new endpoint belongs) or if you just want to know **why the surface looks the way it does** — it's the design counterpart to the [hub-and-connector model](/explanation/connectors/).

The whole thing reduces to one sentence: **the core ships primitives; connectors compose experiences.** The four rules below are what that means in practice.

## 1. Primitives, not compositions

An endpoint exposes a **resource and an operation on it** — create a post, get a post, list a post's replies. It does *not* expose an assembled experience. An "inbox," a "dashboard," an "onboarding flow" are compositions a connector sequences from primitives; they are deliberately *not* endpoints. There is no `GET /inbox` — you build one from the post primitives (a viewer's posts, a thread's replies).

The test for a proposed endpoint: *would two different connectors want this exact shape?* A primitive (the replies-on-a-post list) is reused by every surface. A composition (one app's home screen) is reused by none — it belongs in that app, or in a backend-for-frontend in front of it, not in the core.

## 2. Queries, not bespoke views

When a surface needs a different slice of a resource, that's a **parameter on the existing list**, not a new endpoint. The posts list is one endpoint with filters and a cursor — so "my prompts," "one thread's replies," and a date-bounded slice are the same primitive, queried differently. The alternative — `GET /posts/unread`, `GET /posts/archived`, `GET /threads/{id}/recent` — multiplies the surface without adding capability.

A new endpoint earns its place by exposing a genuinely new operation, not a pre-filtered view of an existing one.

## 3. Projections, not field flags

A resource has one canonical record and **distinct projections** for who's asking. The same post is a public-safe shape to an anonymous viewer and a fuller shape to its author; private enrichments and author-only state live on a separate record or in the `viewer` block and **never** appear in any public projection. Visibility is a property of the projection, not an `?include=private` flag the caller toggles. That keeps "what's public" a server-side decision the client can't accidentally widen.

The transcript follows the same rule from the other direction: it's platform enrichment **lifted into the embed's view** at read time, never a field stored on the post the author writes.

## 4. Descriptions are contracts

The [API reference](/api/reference/) is *generated* from the Zod request/response schemas and route descriptions in `apps/core-api` — there's no hand-maintained copy that can drift. That makes a route's `description` a **contract**, not a comment: if the code enforces ownership, the description says so; if a field is nullable, the schema says so. A description that disagrees with the implementation is a bug, because it ships verbatim to every reader of the reference.

The same schemas mirror the [lexicons](/lexicons/overview/), so the wire format, the generated reference, and the portable AT Protocol records all stay in lockstep. When you change a route's behavior, change its schema and description in the same commit, and regenerate the spec (`npm run gen:openapi -w @antiphony/core-api`). The reference is only as trustworthy as the descriptions it's built from.

## Why it's worth the discipline

These rules are what make the open core *open*. A small contract of reusable primitives is one anyone can build on — a connector the maintainers never imagined runs against the same endpoints a hosted product uses, with no special access. The moment the core starts shipping compositions, it starts encoding one product's UX, and the contract stops being general. Keeping experiences in connectors is what keeps the core small enough to stay stable and open enough to stay reusable.

## Where next?

- [Architecture & connectors](/explanation/connectors/) — the hub-and-connector model these rules serve.
- [The Antiphony lexicons](/lexicons/overview/) — the records these endpoints read and write.
- [API reference](/api/reference/) — the contract these principles produce.
