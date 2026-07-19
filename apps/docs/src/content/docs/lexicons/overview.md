---
title: The Antiphony lexicons
description: The dev.antiphony.* AT Protocol lexicons — the canonical, portable contract every Antiphony app shares.
---

The lexicons are the heart of Antiphony. They are the **AT Protocol record definitions** under the `dev.antiphony.*` namespace that describe everything the system stores — portably, content-addressably, and legibly to existing AT Protocol tooling. The REST API, the Zod schemas in `packages/shared`, and every app built on the core all derive from these.

If you read one thing before building on Antiphony, read this.

The source of truth is the JSON in [`lexicons/dev/antiphony/`](https://github.com/bbthorson/antiphony/tree/master/lexicons/dev/antiphony). This page is the guided tour.

## Design stance

Antiphony's lexicons **mirror the Bluesky (`app.bsky.*`) shapes** wherever one exists, and contribute new ones only where the protocol has a gap. `dev.antiphony.audio.post` is structured like `app.bsky.feed.post`; `dev.antiphony.embed.audio` is modeled on `app.bsky.embed.video`. The payoff: a record an AT Protocol client already understands, differing only where audio call-and-response genuinely needs something new.

Two such gaps are filled here:

- **Audio embeds.** atproto has image, video, external, and record embeds — but no audio. `dev.antiphony.embed.audio` is the protocol's audio attachment.
- **Timed transcripts.** A machine transcript modeled as platform enrichment, not a field the author writes.

## The records

### `dev.antiphony.audio.post` — the one canonical content record

A single record type carries both halves of call-and-response:

- A post **without** a `reply` is a **prompt** — the root of a thread.
- A post **with** a `reply` is a **reply**.

`reply` *presence* is the discriminator — not `title`, which is an optional prompt-only headline. The audio rides in `embed`; the typed `text` is the author's question or caption (max 300 graphemes / 3000 bytes, bsky-semantic), **never** the transcript.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `text` | string | User-authored text. May be empty for pure-audio posts. Required. |
| `title` | string? | Optional headline. A prompt feature; not the discriminator. |
| `embed` | union? | `dev.antiphony.embed.audio`, `…embed.recordWithAudio`, `app.bsky.embed.record`, or `…embed.external`. |
| `reply` | ref? | Present iff this is a reply. `{ root, parent }`, each a `com.atproto.repo.strongRef`. |
| `langs` | string[]? | BCP-47 language tags (max 3). |
| `labels` | union? | Author-applied `com.atproto.label.defs#selfLabels` (content warnings). |
| `createdAt` | datetime | ISO 8601. Required. |

**Threading is content-addressed.** A reply's `reply.root` points at the prompt at the top of the thread; `reply.parent` points at the post being directly answered (the prompt, or another reply). Both are `StrongRef`s (`{ uri, cid }`) — portable pointers that replace the legacy flat `promptId`.

*Who* may reply isn't a field on this record — it's enforced by the AppView (replies form participant-only sub-threads). See [reply gating](/api/overview/#reply-gating).

### `dev.antiphony.embed.audio` — the audio attachment

Antiphony's contribution to the AT Protocol embed family. The **record** form holds the stored, render-time-independent bytes and metadata; the **view** form is what a read returns.

Record (`#main`):

| Field | Type | Notes |
| :--- | :--- | :--- |
| `audio` | blob | `audio/*`, up to 100 MB, content-addressed by CID. Required. |
| `durationMs` | integer? | Duration in **milliseconds** (the platform-wide unit). |
| `alt` | string? | User-authored short description (the audio analogue of image alt text). Not the transcript. |
| `waveform` | integer[]? | Pre-computed visual peaks, normalized 0–100, for instant rendering. |

View (`#view`) — what hydration returns:

| Field | Type | Notes |
| :--- | :--- | :--- |
| `url` | uri | Resolved, **playable** URL — the **processed variant** once opt-in processing has produced one, otherwise the original. In the centralized deployment this is a short-lived signed Storage URL, not the raw blob. Required. |
| `durationMs` | integer? | The processed variant's duration once a byte-mutating stage (`trim`) has run; otherwise the record's value. |
| `waveform` | integer[]? | Server-computed peaks once the `waveform` stage is `ready`; otherwise the client-supplied peaks from the record. |
| `alt` | string? | Copied from the record embed (never processed). |
| `transcript` | ref? | The timed transcript, **lifted** from the enrichment record at read time. Absent until transcription completes. |

The split is the important part: the record stores universal facts; the view carries the resolved playback URL, the lifted transcript, and — for `url`, `durationMs`, and `waveform` — whichever value describes the audio the reader actually plays. `url`, `durationMs`, and `waveform` **move together**: peaks are drawn across a duration and a duration describes specific bytes, so all three resolve to the processed variant or none do. A client that cached `durationMs`/`waveform` at upload time should re-read them from the view, since they change once processing runs (`trim` shortens the audio, `waveform` recomputes the peaks). The transcript is **never stored on the post**.

### `dev.antiphony.audio.transcript` — platform enrichment

A machine-generated, timed transcript of a post's audio. It is **platform-owned enrichment** (like denoise or waveform generation), stored as its own record that references the post by `StrongRef` — the same pattern as likes and labels. It is lifted into `dev.antiphony.embed.audio#view.transcript` at read time.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `subject` | strongRef | The post whose audio this transcribes. Required. |
| `transcript` | ref | A `#timedTranscript` (segments + optional text rollup). Required. |
| `lang` | string? | BCP-47 language tag of the transcript. |
| `model` | string? | Identifier of the model/provider (provenance). |
| `createdAt` | datetime | Required. |

A `#timedTranscript` is an array of `#segment`s — each `{ startMs, endMs, text }` — plus an optional concatenated `text` rollup for consumers that don't need timing (the audio analogue of WebVTT captions).

### `dev.antiphony.embed.recordWithAudio` — quote + audio

The audio analogue of `app.bsky.embed.recordWithMedia`: a post that both quotes another record (`app.bsky.embed.record`) **and** carries its own `dev.antiphony.embed.audio`.

### `dev.antiphony.actor.profile` — the actor profile

One record per actor at the well-known `self` rkey, mirroring `app.bsky.actor.profile`. Carries a public `handle` (distinct from the AT Protocol identity handle), an optional `usageIntent` (e.g. `Podcaster`, `Listener`), and an optional `rssFeed` URL.

This one is **lexicon-only**: the core never stores, serves, or CRUDs it — profile data is owned by the calling app, and this shape exists so a federating or exporting deployment has a well-known record to project that profile into.

## How the records relate

```
dev.antiphony.audio.post  (prompt: no reply)
        ▲  reply.root / reply.parent (StrongRef)
        │
dev.antiphony.audio.post  (reply: has reply)
        │  embed
        ▼
dev.antiphony.embed.audio  ──(#view.transcript lifted at read time)──▶  dev.antiphony.audio.transcript
```

A prompt and its replies are all `audio.post` records, threaded by `StrongRef`. Each carries an `embed.audio`. The transcript lives in its own record and is folded into the embed's view only when it exists.

## How faithful is this to AT Protocol?

The records validate against the official `@atproto/lexicon` parser, blob refs
use the canonical JSON shape (`{ "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType", "size" }`),
and CIDs are **real content addresses** computed by the AT Protocol rules:

- **Blob CIDs** — CIDv1, `raw` codec, sha2-256 over the audio bytes, computed
  at upload. Storage location is *derived* from the CID (never stored on the
  record), so records stay portable across deployments.
- **Record CIDs** — CIDv1, `dag-cbor` codec, sha2-256 over the canonical
  lexicon record (the public fields only). The `cid` on every view — and in
  every reply's `reply.root`/`reply.parent` StrongRef — is therefore a
  verifiable content address.

One thing to know about identity so integrators aren't surprised:

- **`at://` URI authority is the tenant app DID.** Antiphony is the repo owner
  (app-as-repo-owner — see the [authority model](/introduction/architecture/)),
  so a post's URI authority is always the tenant's own `did:web`
  (`at://did:web:<tenant>/dev.antiphony.audio.post/<rkey>`), never an internal
  id or handle. The acting user's own identity, when the caller asserts one,
  rides alongside as the `authorDid` attribution facet — outside the record CID,
  distinct from the URI authority.

## Where next?

- [API reference](/api/overview/) — the REST surface derived from these records.
- [Build your own app](/build-your-own/overview/) — put a client on top of them.
- [Architecture](/introduction/architecture/) — where the record→lexicon transform lives in the core.
