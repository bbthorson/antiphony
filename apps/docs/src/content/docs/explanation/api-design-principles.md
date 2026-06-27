---
title: API design principles
description: The four rules that keep the core's contract small, stable, and open — and how to tell what belongs in the core versus a connector.
---

The consumer API is deliberately small, and it stays that way because every endpoint obeys the same handful of rules. This page is those rules, written down. Read it if you're **extending the core** (deciding whether a new endpoint belongs) or if you just want to know **why the surface looks the way it does** — it's the design counterpart to the [hub-and-connector model](/explanation/connectors/).

The whole thing reduces to one sentence: **the core ships primitives; connectors compose experiences.** The four rules below are what that means in practice.

## 1. Primitives, not compositions

An endpoint exposes a **resource and an operation on it** — list replies, mark one read, set a prompt's status. It does *not* expose an assembled experience. An "inbox," a "dashboard," an "onboarding flow" are compositions a connector sequences from primitives; they are deliberately *not* endpoints. There is no `GET /inbox` — you [build one from the replies primitives](/how-to/reply-inbox/).

The test for a proposed endpoint: *would two different connectors want this exact shape?* A primitive (the replies feed) is reused by every surface. A composition (one app's home screen) is reused by none — it belongs in that app, or in a backend-for-frontend in front of it, not in the core.

## 2. Queries, not bespoke views

When a surface needs a different slice of a resource, that's a **parameter on the existing list**, not a new endpoint. The replies feed is one endpoint with `status`, `readStatus`, `promptId`, `authorUid`, and date filters — so "unread," "archived," and "one prompt's replies" are all the same primitive, queried differently. The alternative — `GET /replies/unread`, `GET /replies/archived`, `GET /prompts/{id}/unread-replies` — multiplies the surface without adding capability.

A new endpoint earns its place by exposing a genuinely new operation, not a pre-filtered view of an existing one.

## 3. Projections, not field flags

A resource has one canonical record and **distinct projections** for who's asking. The same reply is a public-safe shape to an anonymous viewer and a fuller shape to its owner; private enrichments — like [notes](/how-to/reply-inbox/) — live on a separate record and **never** appear in any public projection. Visibility is a property of the projection, not a `?include=notes` flag the caller toggles. That keeps "what's public" a server-side decision the client can't accidentally widen.

## 4. Descriptions are contracts

The [API reference](/api/reference/) is *generated* from the Zod request/response schemas and route descriptions in `apps/core-api` — there's no hand-maintained copy that can drift. That makes a route's `description` a **contract**, not a comment: if the code enforces ownership, the description says so; if a field is nullable, the schema says so. A description that disagrees with the implementation is a bug, because it ships verbatim to every reader of the reference.

So when you change a route's behavior, change its schema and description in the same commit, and regenerate the spec (`npm run gen:openapi -w @vox-pop/core-api`). The reference is only as trustworthy as the descriptions it's built from.

## Why it's worth the discipline

These rules are what make the open core *open*. A small contract of reusable primitives is one anyone can build on — a connector the maintainers never imagined runs against the same endpoints the hosted product uses, with no special access. The moment the core starts shipping compositions, it starts encoding one product's UX, and the contract stops being general. Keeping experiences in connectors is what keeps the core small enough to stay stable and open enough to stay reusable.

## Where next?

- [Architecture & connectors](/explanation/connectors/) — the hub-and-connector model these rules serve.
- [Build a reply inbox](/how-to/reply-inbox/) — rule 1 in action: an experience composed entirely from primitives.
- [API reference](/api/reference/) — the contract these principles produce.
