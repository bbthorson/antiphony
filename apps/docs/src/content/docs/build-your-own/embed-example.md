---
title: "Example: the embed app"
description: A line-by-line read of apps/embed — a real, buildable consumer of the open core.
---

`apps/embed` (`@vox-pop/embed`) is a standalone Vite + React SPA that renders a single prompt in a chrome-less iframe. It ships in this repo, builds to a ~50KB static bundle, and depends on nothing the hosted product keeps private. It is the canonical "app built on the open core" — read it as a template for your own surface.

The source is in [`apps/embed/`](https://github.com/bbthorson/vox-pop-core/tree/main/apps/embed); this page walks the parts that matter.

## The whole data flow in one call

The embed does exactly one thing on load: parse `{handle, promptId}` out of the URL and fetch the public prompt.

```ts
// apps/embed/src/App.tsx
const url = `${CORE_API_BASE_URL}/api/v1/prompts/public/${encodeURIComponent(
    route.handle,
)}/${encodeURIComponent(route.promptId)}`;
const res = await fetch(url, { signal: controller.signal });
const body = await res.json();
if (body.success) {
    // body.data === { user: ProfileView, prompt: PromptView }
}
```

That's the entire backend contract for a read-only surface:

- **No auth.** `GET /api/v1/prompts/public/{handle}/{promptId}` is public and returns a public-safe projection.
- **Standard envelope.** Success is `{ success: true, data: { user, prompt } }`; failure is `{ success: false, error }`. The 404 case is handled explicitly (`Prompt not found.`).
- **Typed payload.** `user` is a `ProfileView` and `prompt` a `PromptView`, both imported from `@vox-pop/shared` — the same Zod-derived types that generate the [API reference](/api/reference/).

## Configuration: point it at any core-api

The origin is the only thing you configure. `apps/embed/src/lib/config.ts` reads it from build-time env:

```ts
export const CORE_API_BASE_URL = stripTrailingSlash(
    import.meta.env.VITE_CORE_API_BASE_URL ?? 'http://localhost:8080',
);
```

Set `VITE_CORE_API_BASE_URL` to your own deployment (`https://api.example.com`) and the same bundle talks to your core. This is the seam that makes the open core reusable: the client hard-codes a contract (`/api/v1/prompts/public/…`), never a host.

## Audio playback goes through the proxy

Audio URLs aren't played directly — they're routed through the core-api audio proxy ([`GET /api/v1/audio`](/api/reference/)), which 302s to a short-lived signed URL:

```ts
export function getAudioProxyUrl(audioUrl: string): string {
    if (audioUrl.includes('/api/v1/audio?url=')) return audioUrl;
    return `${CORE_API_BASE_URL}/api/v1/audio?url=${encodeURIComponent(audioUrl)}`;
}
```

The proxy is anonymous, so unauthenticated playback works. Any surface you build should wrap raw storage URLs the same way rather than hot-linking them — that keeps you compatible with the eventual storage lockdown.

## Rendering: reuse the shared components

The embed renders with `@vox-pop/embed-ui`, the same package the hosted app uses, so the output is pixel-identical across origins:

```tsx
import { DotPair, DotMark, ListenDot, ReplyDot } from '@vox-pop/embed-ui';

<DotPair
    listen={<ListenDot audioUrl={getAudioProxyUrl(prompt.record.audioUrl)} peaks={prompt.record.waveformPeaks} />}
    reply={<ReplyDot promptId={prompt.record.id} creatorHandle={user.handle} isEmbed coreApiBaseUrl={CORE_API_BASE_URL} hostAppBaseUrl={HOST_APP_BASE_URL} />}
/>
```

You don't have to use `@vox-pop/embed-ui` — the `{ user, prompt }` payload is plain data you can render however you like. But reusing it is the fast path to a consistent look.

### The one cross-origin wrinkle: writing a reply

Reading is fully self-contained. **Writing** a reply from an anonymous embed is not, because OTP verification and reply submission must complete same-origin with the host app. `ReplyDot` runs in `isEmbed` mode: it records and uploads anonymously (`POST /api/v1/audio/upload-pending`), then redirects the top frame to `HOST_APP_BASE_URL` to finish auth. If your surface handles its own auth, you won't need this hop — call the authenticated reply endpoints directly.

## Running it

```bash
# 1. Start the core (separate terminal)
npm run dev -w @vox-pop/core-api

# 2. Start the embed — http://localhost:5173/@your-handle/your-prompt-id
cp apps/embed/.env.example apps/embed/.env
npm run dev -w @vox-pop/embed
```

Build a static bundle with `npm run build -w @vox-pop/embed` (output in `apps/embed/dist/`) and drop it behind any static host — no Next.js, no server runtime. The full deploy story is in [`apps/embed/README.md`](https://github.com/bbthorson/vox-pop-core/blob/main/apps/embed/README.md).

## What to copy for your own app

1. **One public fetch** to `GET /api/v1/prompts/public/{handle}/{promptId}` — your read path.
2. **One env var** (`*_CORE_API_BASE_URL`) — point at your core.
3. **The envelope convention** — unwrap `{ success, data }`, handle `404`.
4. **The audio proxy helper** — wrap storage URLs, don't hot-link.
5. *(optional)* **`@vox-pop/embed-ui`** — for a matching look, or render the typed payload yourself.

That's the whole template. Everything past it — auth, prompt creation, feeds, search — is documented in the [API reference](/api/reference/).
