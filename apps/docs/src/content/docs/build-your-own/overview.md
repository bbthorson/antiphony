---
title: Build your own app
description: What the open core gives you, and how to build your own surface on top of it.
---

Antiphony is the infrastructure, not the app. It gives you the call-and-response building blocks — audio posts, replies, identity, transcription — and you build the experience. [Vox Pop](https://voxpop.com) is one app built on it; this repo ships another (`apps/reference`). Nothing stops you from building a third — a mobile client, a custom embed, a Slack bot, a static site that lists a creator's prompts, a call-in voicemail wall.

This page covers **what the core gives you** and the **getting-started path** for building against it. For a worked example, see the [reference app walkthrough](/build-your-own/reference-app/).

## What the open core gives you

| Capability | Where it lives | What you call |
|---|---|---|
| **Audio upload & playback** | `apps/core-api` audio routes | `POST /api/v1/audio/upload`, `POST /api/v1/audio/upload-pending` (anonymous), and the audio resolver `GET /api/v1/audio?url=…` (302s to a short-lived signed URL). |
| **Audio posts (call & response)** | `posts` service | A creator publishes a **prompt** (an `audio.post` with no `reply`); the audience records **replies** (`audio.post`s with a `reply` StrongRef). `POST /api/v1/posts`, `GET /api/v1/posts`, `GET /api/v1/posts/{id}`, `GET /api/v1/posts/{id}/replies`. |
| **Transcription** | platform enrichment | Machine transcripts (`dev.antiphony.audio.transcript`) generated asynchronously and **lifted into the embed's view** at read time — no extra call. |
| **Public REST API** | `apps/core-api` | The full `/api/v1/*` JSON surface with a consistent auth + envelope contract. See the [API reference](/api/overview/). |
| **AT Protocol lexicons** | `lexicons/` + `packages/shared` | MIT-licensed `dev.antiphony.*` records — `audio.post`, `embed.audio`, `audio.transcript`, `actor.profile` — plus the Zod schemas that mirror them. See [The Antiphony lexicons](/lexicons/overview/). |
| **Capture primitives** | `apps/reference/src/capture` | A neutral mic recorder, waveform helper, and audio player — the seed for a shared capture kit once a second client needs them. |

:::note
Some capabilities are split: the open core ships the **lexicon definitions and the pure record→lexicon transform**, while the PDS I/O and OAuth client (the publishing side of AT Proto) live in the hosted layer. The [lexicons](/lexicons/overview/) document the records; the [architecture](/introduction/architecture/) documents the seam.
:::

## Start from the example app you can actually run

The example to learn from lives **right here in this repo**: `apps/reference`, a small Vite + React SPA that signs in anonymously, records audio, uploads it, creates a post, and renders the hydrated view. It is deliberately **unbranded** — the point is to prove the *protocol* is usable by a client carrying no product's design language. It depends on nothing a hosted product keeps private: same public endpoints, same `@antiphony/shared` types.

If you can build `apps/reference`, you can build your own surface. The [reference app walkthrough](/build-your-own/reference-app/) reads it top to bottom.

## Getting-started path

1. **Run the core locally.** Follow the [quick start](/self-hosting/quick-start/) to get `/api/v1/*` serving against the Firebase emulators.
2. **Authenticate.** Almost everything needs a bearer token — a Firebase ID token (anonymous is fine for a public surface) or a session cookie. See [Authentication](/api/overview/#authentication).
3. **Upload audio, then create a post.**
   ```bash
   # upload returns a storage ref you place in the post's embed
   curl -X POST $BASE/api/v1/audio/upload -H "Authorization: Bearer $TOKEN" -F file=@clip.wav
   curl -X POST $BASE/api/v1/posts -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "text": "Ask me anything", "embed": { ... } }'
   ```
4. **Read it back and render it.** `GET /api/v1/posts/{id}` returns a hydrated view — the post, its author, the audio embed with a signed playback URL, the lifted transcript (when ready), and per-viewer state. Drop that payload into your own UI.
5. **Thread replies.** A reply is a post whose `reply.root`/`reply.parent` point at the prompt; list them with `GET /api/v1/posts/{id}/replies`.

## Where next?

- [Reference app](/build-your-own/reference-app/) — the worked `apps/reference` walkthrough.
- [The Antiphony lexicons](/lexicons/overview/) — the records behind every payload above.
- [API reference](/api/overview/) — auth, envelope, and the full endpoint surface.
- [Architecture](/introduction/architecture/) — the route → service → dependency seams you'd extend.
