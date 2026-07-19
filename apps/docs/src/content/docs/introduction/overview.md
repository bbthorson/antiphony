---
title: What is Antiphony?
description: An overview of the protocol and the open-core surface.
---

Antiphony is a **headless service** — MIT-licensed, open infrastructure and an AT Protocol lexicon — that other applications call to store and retrieve audio in an interoperable, portable format, for audio-based call-and-response. These are apps where someone publishes an audio **prompt** (the call) and an audience records audio **replies** (the response). Antiphony owns the post → reply data model, content-addressed audio storage, and an opt-in audio enrichment pipeline — machine transcription, denoising, silence trimming, and waveform generation; it deliberately does **not** own end-user accounts, profiles, or sign-in — that stays with the application that calls it.

It's the kind of backend that sits behind a podcaster's audience-questions feature, a "leave a voice note" embed, an audio AMA, a call-in show's voicemail wall, or any surface built on the same call-and-response shape. [Vox Pop](https://voxpop.com) is one such app, built on Antiphony; this repo also ships a minimal one you can read and run (`apps/reference`).

:::tip[The lexicon is the contract]
The most important thing Antiphony defines is a set of **AT Protocol lexicons** under the `dev.antiphony.*` namespace — chiefly `dev.antiphony.audio.post` and the `dev.antiphony.embed.audio` attachment, the protocol's first audio embed. Every REST shape is derived from them. Start at [The Antiphony lexicons](/lexicons/overview/).
:::

## The one record at the center

Antiphony has a single canonical content record: `dev.antiphony.audio.post`. A post **without** a `reply` is a prompt (the root of a thread); a post **with** a `reply` is a reply. The audio rides in a `dev.antiphony.embed.audio` attachment; the machine transcript is platform enrichment lifted into the view at read time, never stored on the post itself. That one record, mirrored on `app.bsky.feed.post`'s field structure, is what makes the data portable and legible to AT Protocol tooling.

Replies aren't an open comment thread. Antiphony's call-and-response AppView **gates** them: a reply opens a **participant-only sub-thread** between the prompt's author and the responder, and only those two can continue it. That interaction rule — who may answer whom — is part of what Antiphony *is*, not something each app re-invents. See [reply gating](/api/overview/#reply-gating).

:::note
The core is backed by **Firebase** (Firestore, Firebase Auth, Cloud Storage) today, reached through swappable adapter interfaces. Generalizing that backend so Firebase isn't a hard dependency is in active progress — see [Architecture](/introduction/architecture/).
:::

## What's in the open core

- **Hono HTTP service** at `apps/core-api/` — the `/api/v1/*` JSON API surface.
- **Service bindings** at `packages/core/` — pure TypeScript services (`AudioPostService`, `ActorIdentityService`, `StorageService`, …) with pluggable dependency interfaces. Swap in your own backend without touching the route layer.
- **Shared types and Zod schemas** at `packages/shared/` — records, views, and request codecs. The same schemas validate the wire format, generate the API reference, and mirror the lexicons.
- **Lexicons** at `lexicons/dev/antiphony/` — the portable AT Protocol record definitions.

## What's intentionally not in the open core

The core stops at the infrastructure boundary. Anything that's a product, UX, or **identity** decision rather than shared plumbing — accounts, profiles, sign-in, how an app distributes an embed, whether it offers telephony, how it handles **teams or billing** — belongs to the calling application, not the core. The core stays unopinionated about those choices, so different apps can make them differently, while still giving every app the same opinionated **call-and-response model** underneath (the post/reply shape, reply gating, the audio embed). The one identity fact Antiphony *will* hold, if an app wants it there, is the optional actor↔DID mapping (`/actors`) — because that fact has to travel with the portable records, not live only in one caller's database. See [service auth](/api/overview/#authentication).

The protocol has no "organization" primitive, either: grouping people into teams is product machinery an app layers on top. The core treats any `orgId` it sees as an opaque scoping key, nothing more. The tenancy boundary the core *does* enforce is the **origin app** (`originAppId`), derived from the calling app's own credential — see [multi-tenancy](/introduction/architecture/).

## Who is this for?

- **Self-hosters** who want a ready-made audio call-and-response backend instead of building one.
- **App builders** putting their own surface — mobile app, embed, bot, static site — on top of the public API or the lexicons.
- **Contributors** who want to extend the API surface, evolve the lexicons, or help generalize the backend beyond Firebase.

## Where next?

- New to the project? Read the [architecture overview](/introduction/architecture/).
- Want the contract? [The Antiphony lexicons](/lexicons/overview/).
- Want to run it locally? [Quick start](/self-hosting/quick-start/).
- Building your own surface on the core? [Build your own app](/build-your-own/overview/).
- Building against the API? [API reference](/api/overview/).
