---
title: "Example: the reference app"
description: A read of apps/reference — a real, buildable consumer of Antiphony that drives the full record → upload → post → render loop.
---

`apps/reference` (`@antiphony/reference`) is a small Vite + React SPA that drives the **entire** Antiphony loop against `apps/core-api` using only `@antiphony/shared` types and the public REST surface. It is deliberately **unbranded** — the point is to prove the *protocol* is usable by a client that carries no product's design language. It's both the contract's acceptance harness and the seed for a shared capture kit.

The source is in [`apps/reference/`](https://github.com/bbthorson/antiphony/tree/master/apps/reference); this page walks the parts that matter.

## The whole loop in four calls

```
record (mic) → POST /api/v1/audio/upload   → build a dev.antiphony.embed.audio
             → POST /api/v1/posts           → create the audio.post
             → GET  /api/v1/posts/:id        → render the hydrated view
```

That's the full contract for a bidirectional surface: capture audio, hand the bytes to the audio route, reference them from a post, then read the post back hydrated.

## 1. Authenticate (anonymously is fine)

The app signs in **anonymously** against Firebase Auth and uses that ID token as its bearer. No account, no UI — just a token good enough to write and read your own posts:

```ts
// apps/reference/src/lib/firebase.ts (shape)
const cred = await signInAnonymously(auth);
const token = await cred.user.getIdToken();
```

Every call below carries `Authorization: Bearer <token>`. Anonymous auth is the smallest credential that satisfies the API — a real app swaps in its own sign-in.

## 2. Upload the audio

The recorded blob goes to the audio route, which stores it and returns a reference you place in the post's embed:

```ts
// POST /api/v1/audio/upload (multipart) → storage ref for the embed
const audio = await client.uploadAudio(blob);
```

Audio is **never** inlined into the post. The post references it; playback later resolves to a short-lived signed URL.

## 3. Create the post

A prompt is an `audio.post` with **no** `reply`. Its `text` is the typed question; the audio rides in a `dev.antiphony.embed.audio`:

```ts
// POST /api/v1/posts
const created = await client.createPost({
    text: 'What should we cover next week?',
    embed: audio, // a dev.antiphony.embed.audio
});
```

The server stamps `originAppId` (the tenancy key) and `createdAt` for you — you never send them. A reply would carry a `reply: { root, parent }` instead; the *presence* of `reply` is what makes it a reply.

## 4. Read it back, hydrated

`GET /api/v1/posts/{id}` returns the **view**, not the raw record:

```ts
// GET /api/v1/posts/:id → AudioPostView
const view = await client.getPost(created.id);
// view.embed.url       → signed, playable audio URL
// view.embed.transcript → lifted transcript (absent until transcription runs)
// view.author           → profile basic
// view.viewer           → per-viewer state (e.g. isAuthor)
```

Three things the view does that the record can't:

- **Signed playback URL.** `embed.url` is a short-lived signed Storage URL — the client plays that, never a raw blob path.
- **Lifted transcript.** If a `dev.antiphony.audio.transcript` exists for the post, it's folded into `embed.transcript` at read time. Until then the view shows "no transcript yet."
- **Viewer state.** `viewer` carries per-reader relationship (starting with `isAuthor`) — the projection rule from [API design principles](/explanation/api-design-principles/#3-projections-not-field-flags) in action.

## Configuration: point it at any core-api

The origin is the only thing you configure. The app reads it from build-time env (`VITE_CORE_API_BASE_URL`) — point it at the emulator (`http://localhost:8090`) or the live API (`https://api.antiphony.dev`) and the same bundle talks to your core. The client hard-codes a *contract* (`/api/v1/posts`, `/api/v1/audio`), never a host.

## The capture kit

`apps/reference/src/capture/` holds the neutral audio primitives — `use-audio-recorder.ts`, `waveform.ts`, `AudioPlayer.tsx`. They carry no product styling, and they're the candidates to lift into a shared `packages/capture-kit` once a second consumer needs them. For now they live in the reference app to keep it self-contained.

## Running it

```bash
# 1. emulators (separate terminal)
npx firebase emulators:start --only auth,firestore,storage --project demo-antiphony

# 2. core-api on :8090, pointed at the emulators
PORT=8090 ANTIPHONY_USE_EMULATOR=true GCLOUD_PROJECT=demo-antiphony \
  ANTIPHONY_ORIGIN_APP_ID=reference npm run dev -w @antiphony/core-api

# 3. the reference app
npm run dev -w @antiphony/reference
```

Open the app, record, and watch it round-trip create → fetch → render. The full run notes (including running against the live API) are in [`apps/reference/README.md`](https://github.com/bbthorson/antiphony/blob/master/apps/reference/README.md).

## What to copy for your own app

1. **A bearer token** — anonymous Firebase auth is the floor; swap in your own sign-in.
2. **Upload, then reference** — `POST /api/v1/audio/upload`, place the result in the post's `embed`.
3. **Create with `POST /api/v1/posts`** — `reply` presence is prompt-vs-reply; the server stamps tenancy + timestamps.
4. **Read the view, not the record** — `GET /api/v1/posts/{id}` gives you the signed URL, the lifted transcript, and viewer state.
5. **The envelope convention** — unwrap `{ success, data }`, handle errors.

That's the whole template. Everything past it — threads, lists, filters — is documented in the [API reference](/api/reference/).
