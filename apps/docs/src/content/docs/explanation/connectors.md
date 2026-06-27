---
title: Architecture & connectors
description: The mental model — Vox Pop Core as a hub, and every surface around it as a directional connector.
---

This page is the **mental model** for the whole project: why the API is scoped the way it is, and where your own surface plugs in. It's the *why* behind the [API reference](/api/overview/) — read it once and the shape of every endpoint stops being arbitrary.

(If you're looking for how the service is wired *internally* — ports, adapters, the composition root — that's the [Architecture](/introduction/architecture/) page. This page is about the surfaces *around* the core, not the layers *inside* it.)

## The core is a hub

Vox Pop Core doesn't have a UI. It isn't an app. It's a **hub**: a single source of truth for identity, prompts, replies, and audio, with a contract in front of it. Everything a human or a machine actually touches — a web dashboard, an embed on a blog, a phone call, a mobile app — is a separate **connector** that talks to the hub over that contract.

```
                       ┌───────────────────────────┐
   web dashboard ────▶ │                           │ ◀──── mobile app
                       │      Vox Pop Core         │
   embed / pages ────▶ │   (identity · prompts ·   │ ◀──── your app
                       │     replies · audio)      │
   phone / IVR  ─────▶ │           hub             │ ◀──── RSS / federation
                       └───────────────────────────┘
```

The hosted product at [voxpop.com](https://voxpop.com) is **one** connector — the reference one. This repo ships a second you can read end to end: [`apps/embed`](/build-your-own/embed-example/). Your surface is just one more arrow into the same hub.

This is the single rule that explains the API: **the core ships primitives, and connectors compose experiences from them.** An "inbox," an "onboarding flow," a "dashboard" — those are compositions a connector assembles; they are deliberately *not* endpoints. A reply "inbox," for instance, is something you [build from the replies primitives](/how-to/reply-inbox/) (feed, read-state, notes, status, search) — there is no `GET /inbox`.

## Connectors are directional

A connector isn't defined by what it *is* (a phone, a web page) but by **which way data flows** across it. Three directions:

| Direction | Data flow | Examples |
|---|---|---|
| **Egress** | Reads *out* of the hub — public-safe projections for display. | Public prompt pages, embeds, share cards, a static site listing a creator's prompts. |
| **Ingress** | Writes *into* the hub from a non-REST modality. | A phone call that captures a voicemail and lands it as a reply; an import that turns an external feed into prompts. |
| **Bidirectional** | Both — an authenticated surface that reads *and* writes on a user's behalf. | The creator dashboard, a mobile client, any app that lists replies *and* records new ones. |

Layer two more attributes on top of direction and you have the full taxonomy:

- **Modality** — *how* it bridges to the outside world: HTTP/JSON, voice/telephony, RSS, AT Protocol federation, a rendered web UI.
- **Config** — every connector that needs settings (which number, which feed, enabled or not) stores them in the hub, so the connector itself stays stateless and a single management surface can configure any of them.

`apps/embed` in this repo is a minimal **egress, HTTP** connector: it reads one public prompt and renders it, writes nothing, needs no config. That's the smallest possible connector — and the template for your own.

## The three planes

Connectors don't all knock on the same door. The hub exposes **three planes**, each with its own audience and auth model:

| Plane | Path shape | Who calls it | Auth |
|---|---|---|---|
| **Consumer API** | `/api/v1/*` | Apps built on the core — yours, the dashboard, mobile. | Bearer token (or anonymous for public projections). |
| **Ingestion** | `system/*` | Ingress connectors writing on behalf of a captured event. | System-to-system, not end-user tokens. |
| **Control** | `/api/v1/connectors/*` | A management UI configuring a connector's settings. | The owning user. |

The **consumer and control planes are both documented** — both live under `/api/v1/*` and appear in the [reference](/api/overview/). The consumer API is the front door for any app built on the core; the control plane (`/api/v1/connectors/*`) lets a connector's owner read and write its settings through a uniform contract. The **ingestion plane is the exception**: `system/*` is system-to-system plumbing an ingress connector uses to write on behalf of a captured event, so it stays out of the public reference by design — it isn't something a third-party client calls with an end-user token.

The split is the point: a captured voicemail becoming a reply is a fundamentally different operation from a logged-in user fetching their feed, so it lives on a different plane with a different trust model. Keeping them separate is what lets the consumer contract stay small and stable.

## Where your app fits

You're building a connector. To place it, answer two questions:

1. **Which direction?** Reading public content to display → **egress**, and you may need no auth at all (start at `GET /api/v1/prompts/public/{handle}/{promptId}`). Reading and writing on a user's behalf → **bidirectional**, and you'll pass a bearer token. Bridging a non-REST modality *into* the hub → that's **ingress**, an ingestion-plane concern.
2. **Which plane?** Almost every app you'd build talks to the **consumer API** (`/api/v1/*`) — that's the documented surface, and it's all you need for the egress and bidirectional cases.

For the common path — read public content, optionally authenticate to write — start with [Build your own app](/build-your-own/overview/), then the [embed walkthrough](/build-your-own/embed-example/) for a connector you can run today.

## Why it's scoped this way

The hub-and-connector shape is what makes the open core *open*. Because experiences are composed in connectors rather than baked into endpoints, the core's contract is small, stable, and not coupled to any one product's UX. You can build a connector the maintainers never imagined — a Slack bot, a kiosk, a different mobile app — against the same primitives the hosted product uses, with no special access. The hub doesn't know or care how many connectors point at it.

## Where next?

- [Build your own app](/build-your-own/overview/) — the getting-started path for a new connector.
- [Example: the embed app](/build-your-own/embed-example/) — a working egress connector you can run today.
- [API design principles](/explanation/api-design-principles/) — the rules that keep the contract small: primitives, queries, projections, contracts.
- [Build a reply inbox](/how-to/reply-inbox/) — a cookbook that composes the replies primitives into a full inbox.
- [API reference](/api/overview/) — the consumer-plane contract in full.
- [Architecture](/introduction/architecture/) — the *internal* ports-and-adapters wiring of the hub itself.
