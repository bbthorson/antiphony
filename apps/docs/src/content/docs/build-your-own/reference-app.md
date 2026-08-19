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

## 1. Authenticate (from the server side, always)

This is the part most worth copying, and the part people get wrong first.

Antiphony's only credential is a **service token**, and it authenticates an *application*, not a person — whoever holds it can act as any user in that tenancy. So it can never ship in a browser bundle, and the reference app does **not** call core-api directly. The browser calls `/api/v1/*` on its own origin, and a small Vite middleware forwards each request with the credential attached:

```
browser ──/api/v1/*──▶ dev BFF ──Authorization: Bearer <service token>──▶ core-api
                                 X-Antiphony-Acting-Actor: <your user id>
```

```ts
// apps/reference/server/dev-bff.ts (shape)
headers.set('authorization', `Bearer ${serviceToken()}`);
headers.set('x-antiphony-acting-actor', resolveActingActor(req));
```

That is the shape of **every** real integration — only the hop's implementation changes (your BFF, worker, or edge function instead of Vite middleware). The one thing standing in for something real is `resolveActingActor()`, which returns a fixed id from env because the reference app has no accounts; a production BFF resolves it from its own session. Antiphony never sees your users' credentials, and it stamps whatever id you assert as the post's opaque `authorId`.

The client itself (`src/lib/api.ts`) therefore carries **no token and no `Authorization` header** — and wouldn't change if you swapped the Vite middleware for a real backend.

## 2. Upload the audio

The recorded blob goes to the audio route, which hashes it, stores it content-addressed, and returns the canonical blob ref you place in the post's embed verbatim:

```ts
// POST /api/v1/audio/upload (multipart) → { $type: 'blob', ref: { $link: '<cid>' }, mimeType, size }
const audio = await client.uploadAudio(blob);
```

Audio is **never** inlined into the post. The post references it by content address (its CID); playback later resolves that reference to a short-lived signed URL.

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

`GET /api/v1/posts/{postId}` returns the **view**, not the raw record:

```ts
// GET /api/v1/posts/:id → AudioPostView
const view = await client.getPost(created.id);
// view.embed.url        → signed, playable audio URL
// view.embed.transcript → lifted transcript (absent until transcription runs)
// view.authorId         → YOUR user id, opaque — join your own profile onto it
// view.viewer           → per-viewer state (e.g. isAuthor, canReply)
```

Three things the view does that the record can't:

- **Signed playback URL.** `embed.url` is a short-lived signed Storage URL — the client plays that, never a raw blob path.
- **Lifted transcript.** If a `dev.antiphony.audio.transcript` exists for the post, it's folded into `embed.transcript` at read time. Until then the view shows "no transcript yet."
- **Viewer state.** `viewer` carries per-reader relationship (`isAuthor`, `canReply`) — the projection rule from [API design principles](/explanation/api-design-principles/#3-projections-not-field-flags) in action.

Note what the view does **not** carry: a hydrated author profile. Antiphony holds no user data, so it returns the opaque `authorId` your BFF asserted (plus `authorDid` if you sent one) and leaves display identity — name, avatar, handle — for you to join back on. `PostView.tsx` just renders the raw id, which is exactly what a protocol-level client should do.

## Configuration: point it at any core-api

Configuration lives on the **server** side of the BFF, not in the bundle:

| Variable | Purpose |
|---|---|
| `ANTIPHONY_CORE_API_URL` | Where the BFF forwards — a local core-api (`http://localhost:8787`) or the live API (`https://api.antiphony.dev`). |
| `ANTIPHONY_SERVICE_TOKEN` | The app's credential. Must match an `appId:token` pair in core-api's `ANTIPHONY_APP_TOKENS`. |
| `ANTIPHONY_ACTING_ACTOR` | Who the BFF says is acting. Stands in for a real session lookup. |

None of these carry a `VITE_` prefix, and that's the point: Vite only inlines `VITE_`-prefixed vars into the client bundle, so the token stays server-side **by construction** rather than by discipline. The browser-facing client hard-codes a *contract* (`/api/v1/posts`, `/api/v1/audio`) and a same-origin base, never a host or a credential.

One nice consequence: since the browser never makes a cross-origin request, no CORS configuration constrains this app at all — it works the same against a local core-api and the live API. That property is why core-api carries no CORS middleware to begin with.

## The capture kit

`apps/reference/src/capture/` holds the neutral audio primitives — `use-audio-recorder.ts`, `waveform.ts`, `AudioPlayer.tsx`. They carry no product styling, and they're the candidates to lift into a shared `packages/capture-kit` once a second consumer needs them. For now they live in the reference app to keep it self-contained.

## Running it

```bash
# 1. core-api on :8787, via `wrangler dev`. Its config lives in
#    apps/core-api/.dev.vars (gitignored) — see the quick start:
#
#      DATABASE_URL="postgresql://…"
#      ANTIPHONY_APP_TOKENS="reference:reference-local-dev-token-0123456789abcdef"
#      ANTIPHONY_APP_DIDS="reference:did:web:your-domain.example"
#      ANTIPHONY_PUBLIC_BASE_URL="http://localhost:8787"
#
#    The token must match ANTIPHONY_SERVICE_TOKEN in apps/reference/.env.development;
#    the DID pin needs a domain you control.
npm run dev -w @antiphony/core-api

# 2. the reference app (serves the UI and the BFF together)
npm run dev -w @antiphony/reference
```

Open the app, record, and watch it round-trip create → fetch → render. There's no sign-in step — the BFF asserts the acting actor for you. The full run notes (including running against the live API, and why the local view comes back without an `embed`) are in [`apps/reference/README.md`](https://github.com/bbthorson/antiphony/blob/master/apps/reference/README.md).

## What to copy for your own app

1. **A server-side hop that holds the credential** — this is the integration pattern, not a shortcut around one. Your backend presents the [service token](/api/overview/#authentication) and asserts your end user as the acting actor; the browser never sees either. Replace the Vite middleware with your own backend and nothing else in this list changes.
2. **Upload, then reference** — `POST /api/v1/audio/upload`, place the returned blob ref in the post's `embed` verbatim.
3. **Create with `POST /api/v1/posts`** — `reply` presence is prompt-vs-reply; the server stamps tenancy + timestamps.
4. **Read the view, not the record** — `GET /api/v1/posts/{postId}` gives you the signed URL, the lifted transcript, and viewer state. Join your own profile data onto the opaque `authorId`.
5. **The envelope convention** — unwrap `{ success, data }`, handle errors.

That's the whole template. Everything past it — threads, lists, filters — is documented in the [API reference](/api/reference/).
