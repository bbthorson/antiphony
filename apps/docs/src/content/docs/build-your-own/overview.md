---
title: Build your own app
description: What the open core gives you, and how to build your own surface on top of it.
---

Vox Pop Core is the infrastructure, not the app. It gives you the call-and-response building blocks — prompts, replies, identity, audio — and you build the experience. [voxpop.com](https://voxpop.com) is one app built on it; this repo ships another (`apps/embed`). Nothing stops you from building a third — a mobile client, a custom embed, a Slack bot, a static site that lists a creator's prompts, a call-in voicemail wall.

This page covers **what the core gives you** and the **getting-started path** for building against it. For a worked example, see the [embed walkthrough](/build-your-own/embed-example/).

## What the open core gives you

| Capability | Where it lives | What you call |
|---|---|---|
| **Audio recording & playback** | `apps/core-api` audio routes | `POST /api/v1/audio/upload`, `POST /api/v1/audio/upload-pending` (anonymous), and the audio proxy `GET /api/v1/audio?url=…` (302s to a short-lived signed URL). |
| **Prompt → reply messaging** | `prompts` + `replies` services | A creator publishes a **prompt** (an audio question); the audience records **replies**. CRUD + lifecycle + feed + search over `/api/v1/prompts` and `/api/v1/replies`. |
| **Public, anonymous read path** | `prompts-public` route | `GET /api/v1/prompts/public/{handle}/{promptId}` returns a public-safe `{ user, prompt }` with no auth — the entry point for any embed or share surface. |
| **Public REST API** | `apps/core-api` | The full `/api/v1/*` JSON surface with a consistent auth + envelope contract. See the [API reference](/api/overview/). |
| **Embed UI components** | `packages/embed-ui` | `@vox-pop/embed-ui` — the composed React components (`ListenDot`, `ReplyDot`, `DotPair`, …) both `apps/embed` and the hosted app render, so your surface can look identical with no rebuild. |
| **RSS import** | `rss-parse` route | `POST /api/v1/rss/parse` — server-side parse of an external podcast RSS/Atom feed into a normalized summary + preview items. Public, no auth, CORS-friendly. |
| **AT Protocol identity** | `lexicons/` + `packages/core` | MIT-licensed lexicons (`com.voxpop.audio.prompt`, `com.voxpop.actor.profile`) plus the record→lexicon transform in `packages/core/services/atproto-lexicon.ts`, so federation peers and self-hosters can interoperate. See the [lexicons README](https://github.com/bbthorson/vox-pop-core/blob/main/lexicons/README.md). |

:::note
Some capabilities are split: the open core ships the **lexicon definitions and the pure transform**, while the PDS I/O and OAuth client (the publishing side of AT Proto) live in the hosted layer. The lexicons README documents the seam.
:::

## Start from the example app you can actually run

voxpop.com's hosted web app is the largest consumer of the core, but it's closed-source — so the example to learn from lives **right here in this repo**: `apps/embed`, a ~50KB Vite + React SPA that fetches one public prompt and renders it. It depends on nothing voxpop.com has that you don't — same public endpoint, same `@vox-pop/embed-ui` components.

If you can build `apps/embed`, you can build your own surface. The [embed walkthrough](/build-your-own/embed-example/) reads it top to bottom.

## Getting-started path

1. **Run the core locally.** Follow the [quick start](/self-hosting/quick-start/) to get `/api/v1/*` serving against the Firebase emulators.
2. **Fetch a public prompt — no auth required.**
   ```bash
   curl http://localhost:8080/api/v1/prompts/public/your-handle/your-prompt-id
   # → { "success": true, "data": { "user": {…}, "prompt": {…} } }
   ```
   This is the one call every read-only surface needs. The response is already projected to a public-safe shape.
3. **Render it.** Drop the `{ user, prompt }` payload into your own UI, or reuse `@vox-pop/embed-ui` to match the hosted look. See the [embed walkthrough](/build-your-own/embed-example/).
4. **Add writes when you need them.** Recording a reply, creating prompts, and reading a creator's own feed are authenticated — pass a Firebase ID token or session cookie as a bearer token. See [Authentication](/api/overview/#authentication).
5. **Wire identity & RSS if relevant.** Import a creator's existing podcast feed with `POST /api/v1/rss/parse`; interoperate over AT Proto using the [lexicons](https://github.com/bbthorson/vox-pop-core/blob/main/lexicons/README.md).

## Where next?

- [Embed example](/build-your-own/embed-example/) — the worked `apps/embed` walkthrough.
- [API reference](/api/overview/) — auth, envelope, and the full endpoint surface.
- [Architecture](/introduction/architecture/) — the route → service → dependency seams you'd extend.
- Building a creator-facing surface? The hosted product's [creator help center](https://voxpop.app/help) documents the end-user side of prompts and replies.
