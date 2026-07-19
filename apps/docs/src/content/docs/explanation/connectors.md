---
title: Architecture & connectors
description: The mental model — Antiphony's core as a hub, and every surface around it as a directional connector.
---

This page is the **mental model** for the whole project: why the API is scoped the way it is, and where your own surface plugs in. It's the *why* behind the [API reference](/api/overview/) — read it once and the shape of every endpoint stops being arbitrary.

(If you're looking for how the service is wired *internally* — ports, adapters, the composition root — that's the [Architecture](/introduction/architecture/) page. This page is about the surfaces *around* the core, not the layers *inside* it.)

## The core is a hub

Antiphony's core doesn't have a UI. It isn't an app. It's a **hub**: a single source of truth for portable audio posts, replies, and transcription, with a contract in front of it — deliberately not accounts or profiles, which stay with each connector. Everything a human or a machine actually touches — a web dashboard, an embed on a blog, a phone call, a mobile app — is a separate **connector** that talks to the hub over that contract.

```
                       ┌───────────────────────────┐
   web dashboard ────▶ │                           │ ◀──── mobile app
                       │        Antiphony          │
   embed / pages ────▶ │  (audio posts · replies   │ ◀──── your app
                       │    · transcripts · DIDs)  │
   phone / IVR  ─────▶ │           hub             │ ◀──── RSS / federation
                       └───────────────────────────┘
```

[Vox Pop](https://voxpop.audio) is **one** connector — a hosted product built on the hub. This repo ships a second you can read end to end: [`apps/reference`](/build-your-own/reference-app/). Your surface is just one more arrow into the same hub.

This is the single rule that explains the API: **the core ships primitives, and connectors compose experiences from them.** An "inbox," an "onboarding flow," a "dashboard" — those are compositions a connector assembles; they are deliberately *not* endpoints. A reply "inbox," for instance, is something a connector builds from the post primitives — a thread is `GET /api/v1/posts/{id}/replies`, a viewer's posts are `GET /api/v1/posts`, and the replies addressed to an author (the raw feed a connector filters into an inbox) are `GET /api/v1/posts?rootAuthor=…`. There is no `GET /inbox`: the "read / unread," "archived," and unread-count layers that make it an *inbox* live in the connector, over those primitives.

## Connectors are directional

A connector isn't defined by what it *is* (a phone, a web page) but by **which way data flows** across it. Three directions:

| Direction | Data flow | Examples |
|---|---|---|
| **Egress** | Reads *out* of the hub — public-safe projections for display. | Public post pages, embeds, share cards, a static site listing a creator's prompts. |
| **Ingress** | Writes *into* the hub from a non-REST modality. | A phone call that captures a voicemail and lands it as a reply post; an import that turns an external feed into prompts. |
| **Bidirectional** | Both — an authenticated surface that reads *and* writes on a user's behalf. | The creator dashboard, a mobile client, any app that lists replies *and* records new ones. |

Layer two more attributes on top of direction and you have the full taxonomy:

- **Modality** — *how* it bridges to the outside world: HTTP/JSON, voice/telephony, RSS, AT Protocol federation, a rendered web UI.
- **Config** — every connector that needs settings (which number, which feed, enabled or not) stores them somewhere, so the connector itself stays stateless. *Managing* that config is an app/ops concern, not part of the core contract.

`apps/reference` in this repo is a minimal **bidirectional, HTTP** connector: it signs in, records audio, creates a post, and reads it back. The smallest possible *egress* connector reads a single public post and renders it — that's the template for an embed.

## The planes

Connectors don't all knock on the same door. The hub exposes distinct **planes**, each with its own audience and auth model:

| Plane | Path shape | Who calls it | Auth |
|---|---|---|---|
| **Consumer API** | `/api/v1/*` | Apps built on the core — yours, a dashboard, mobile. | A service credential asserting the acting actor (or, for local demos, an anonymous end-user token) — see [Authentication](/api/overview/#authentication). Public projections accept no token. |
| **Ingestion** | `system/*` | Ingress connectors writing on behalf of a captured event. | System-to-system, not end-user tokens. |

The **consumer API** is the documented front door — it's all you need for the egress and bidirectional cases, and it's what appears in the [reference](/api/overview/). The **ingestion plane** (`system/*`) is the exception: it's system-to-system plumbing an ingress connector uses to write on behalf of a captured event, so it stays out of the public reference by design — it isn't something a third-party client calls with an end-user token.

The split is the point: a captured voicemail becoming a reply is a fundamentally different operation from a logged-in user fetching their feed, so it lives on a different plane with a different trust model. Keeping them separate is what lets the consumer contract stay small and stable.

## Where your app fits

You're building a connector. To place it, answer two questions:

1. **Which direction?** Reading content to display → **egress** (often an anonymous viewer token). Reading and writing on a user's behalf → **bidirectional**, and you'll pass a bearer token. Bridging a non-REST modality *into* the hub → that's **ingress**, an ingestion-plane concern.
2. **Which plane?** Almost every app you'd build talks to the **consumer API** (`/api/v1/*`) — that's the documented surface, and it's all you need for the egress and bidirectional cases.

For the common path — read content, optionally authenticate to write — start with [Build your own app](/build-your-own/overview/), then the [reference app walkthrough](/build-your-own/reference-app/) for a connector you can run today.

## Why it's scoped this way

The hub-and-connector shape is what makes the open core *open*. Because experiences are composed in connectors rather than baked into endpoints, the core's contract is small, stable, and not coupled to any one product's UX. You can build a connector the maintainers never imagined — a Slack bot, a kiosk, a different mobile app — against the same primitives a hosted product uses, with no special access. The hub doesn't know or care how many connectors point at it.

## Where next?

- [Build your own app](/build-your-own/overview/) — the getting-started path for a new connector.
- [Example: the reference app](/build-your-own/reference-app/) — a working connector you can run today.
- [API design principles](/explanation/api-design-principles/) — the rules that keep the contract small: primitives, queries, projections, contracts.
- [The Antiphony lexicons](/lexicons/overview/) — the records every connector reads and writes.
- [Architecture](/introduction/architecture/) — the *internal* ports-and-adapters wiring of the hub itself.
