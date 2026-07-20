---
title: Build your own app
description: What the open core gives you, and how to build your own surface on top of it.
---

Antiphony is the infrastructure, not the app. It gives you the call-and-response building blocks — audio posts, replies, per-request actor/DID attribution, transcription — and you build the experience, including accounts and profiles. [Vox Pop](https://voxpop.audio) is one app built on it; this repo ships another (`apps/reference`). Nothing stops you from building a third — a mobile client, a custom embed, a Slack bot, a static site that lists a creator's prompts, a call-in voicemail wall.

This page covers **what the core gives you** and the **getting-started path** for building against it. For a worked example, see the [reference app walkthrough](/build-your-own/reference-app/).

## What the open core gives you

| Capability | Where it lives | What you call |
|---|---|---|
| **Audio upload & playback** | `apps/core-api` audio routes | `POST /api/v1/audio/upload` (content-addressed — returns a blob ref, not a URL) and the audio resolver `GET /api/v1/audio?url=…` (302s to a short-lived signed URL). |
| **Audio posts (call & response)** | `posts` service | A creator publishes a **prompt** (an `audio.post` with no `reply`); the audience records **replies** (`audio.post`s with a `reply` StrongRef). `POST /api/v1/posts`, `GET /api/v1/posts`, `GET /api/v1/posts/{postId}`, `GET /api/v1/posts/{postId}/replies`. |
| **Audio enrichment** | platform processing | Opt-in, out-of-band processing over a post's audio: **transcription** (`dev.antiphony.audio.transcript`), **denoising**, silence **trimming**, and **waveform** generation. Request stages in the `processing` opt-in on `POST /api/v1/posts` (at create) or `PATCH /api/v1/posts/{postId}` (post-hoc); results are **lifted into the embed's view** at read time — no extra call. Enrichment runs out of band, so you can also opt into a **push** when a stage settles (see [Receiving enrichment webhooks](#receiving-enrichment-webhooks)) instead of polling. See [Configuration](/self-hosting/configuration/#audio-enrichment) for wiring providers. |
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
2. **Authenticate.** A real integration uses a service credential + an asserted acting actor; the local/demo path (what `apps/reference` uses) is an anonymous Firebase token. See [Authentication](/api/overview/#authentication).
3. **Upload audio, then create a post.**
   ```bash
   # upload hashes the bytes and returns a canonical blob ref
   curl -X POST $BASE/api/v1/audio/upload -H "Authorization: Bearer $TOKEN" -F file=@clip.wav
   # → { "success": true, "data": { "blob": { "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType": "audio/wav", "size": 12345 } } }

   curl -X POST $BASE/api/v1/posts -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "text": "Ask me anything", "embed": { "$type": "dev.antiphony.embed.audio", "audio": <blob from above> } }'
   ```
4. **Read it back and render it.** `GET /api/v1/posts/{postId}` returns a hydrated view — the post, its author, the audio embed with a signed playback URL, the lifted transcript (when ready), and per-viewer state. Drop that payload into your own UI.
5. **Thread replies.** A reply is a post whose `reply.root`/`reply.parent` point at the prompt; list them with `GET /api/v1/posts/{postId}/replies`. Replies are gated to a participant-only sub-thread — check `viewer.canReply` on the view before showing a reply control (see [reply gating](/api/overview/#reply-gating)).

## Receiving enrichment webhooks

Enrichment runs **out of band**: a create or `PATCH` returns as soon as the work is queued, and the stages settle later on the worker's clock. You have two ways to learn a result landed:

- **Pull** — re-read `GET /api/v1/posts/{postId}` and diff its `processing` state. Always available, but laggy and wasteful (most reads find nothing changed).
- **Push** — have the core POST you a small signed webhook the moment each stage reaches a terminal state (`ready` / `failed` / `skipped`). No polling; you act on the push and only fetch the artifact when you actually want it.

The webhook is an **accelerator, not a source of truth**. The authoritative record is always the post's `processing` state in the view; the push just makes the common case fast. Delivery is **best-effort**, so your receiver must still be able to reconcile from the view — a dropped webhook is a latency regression, never lost data.

Wiring is per tenant and done by the **operator**, not through an API call: they set your receiver URL and a shared secret (see [webhook configuration](/self-hosting/configuration/#stage-settled-webhooks)). A tenant with none configured simply gets no webhooks.

### The payload

One POST per stage that settles, `Content-Type: application/json`:

```json
{
  "postId": "3kb2…",
  "originAppId": "voxpop",
  "stage": "transcribe",
  "status": "ready",
  "occurredAt": "2026-07-19T14:03:11.204Z"
}
```

- `stage` ∈ `denoise | trim | transcribe | waveform`; `status` ∈ `ready | failed | skipped` (`pending` never fires — it isn't a settle).
- `occurredAt` is the server settle time, for ordering and replay detection.
- The **artifact itself** (transcript text, signed URL, waveform peaks) is deliberately **not** included. The status tells you whether it's worth fetching; the hydrated view (`GET /api/v1/posts/{postId}`) is where you fetch it. A `waveform: skipped` needs no follow-up at all; a `transcribe: ready` invites one, on your terms.

### Verify the signature

Every request carries `X-Antiphony-Signature: sha256=<hex>`, an HMAC-SHA256 of the **raw request body** keyed by your webhook secret. Recompute it over the exact bytes you received and compare in constant time — this is what lets you trust the payload without a callback to the core.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false; // no signature → reject (unsigned probe, missing header)
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Sign and compare over the **raw body**, before any JSON parse and re-serialize — a reparsed body's bytes (key order, whitespace) won't match. Also reject a request whose `occurredAt` is far from now to blunt replay.

### Dedupe by "latest wins", not "seen before"

The same stage's webhook can arrive more than once, and "already saw this" is the wrong test: a byte-mutating stage re-running legitimately settles a derived stage (`transcribe` / `waveform`) a second time — `ready → pending → ready` — and that second `ready` describes the **recomputed** artifact, a new correct event, not a duplicate to suppress. Treat each event as **latest-wins for `(postId, stage)`**, using `occurredAt` as the tiebreaker, rather than ignoring anything you've seen before.

## Where next?

- [Reference app](/build-your-own/reference-app/) — the worked `apps/reference` walkthrough.
- [The Antiphony lexicons](/lexicons/overview/) — the records behind every payload above.
- [API reference](/api/overview/) — auth, envelope, and the full endpoint surface.
- [Architecture](/introduction/architecture/) — the route → service → dependency seams you'd extend.
