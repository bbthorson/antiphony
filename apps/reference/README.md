# @antiphony/reference

The **neutral reference creation app** for the Antiphony contract — and its
acceptance harness. It drives the full loop against `@antiphony/core-api`
using only `@antiphony/shared` types and the public REST surface:

```
record (mic) → POST /api/v1/audio/upload → build embed.audio
            → POST /api/v1/posts → GET /api/v1/posts/:id → render hydrated view
```

It is deliberately **unbranded**. The point is to prove the *protocol* is
usable by a client that carries no product's design language. A branded
client (Vox Pop, Bardcast) is a Tier-3 concern and lives elsewhere.

## The dev BFF (`server/dev-bff.ts`)

Antiphony's only credential is a **service token**, and a service token
authenticates an *application*, not a person — whoever holds it can act as any
user in that tenancy. It therefore must never reach a browser bundle, so this
app does **not** call core-api directly.

Instead the browser calls `/api/v1/*` on its **own** origin, and a small Vite
middleware forwards those requests to core-api, attaching the credential and
the acting-actor assertion server-side:

```
browser ──/api/v1/*──▶ dev BFF ──Authorization: Bearer <service token>──▶ core-api
                                 X-Antiphony-Acting-Actor: <your user id>
```

That is the shape of every real integration; only the hop's *implementation*
differs (your BFF, worker, or edge function instead of Vite middleware). The
one place this stands in for something real is `resolveActingActor()`, which
returns a fixed id from env — a production BFF resolves it from its own
session. `src/lib/api.ts` carries no token and would not change.

Server-side env deliberately carries **no `VITE_` prefix**, because Vite only
inlines `VITE_`-prefixed vars into the client bundle — the token stays out of
it by construction rather than by discipline.

## Capture-kit seed

`src/capture/` holds the neutral audio primitives — `use-audio-recorder.ts`,
`waveform.ts`, `AudioPlayer.tsx`. These are the candidates to lift into a
shared `packages/capture-kit` once a second consumer needs them (the
Stream 1.5 → capture-kit split). For now they live here to keep this PR
self-contained.

## Run it (local emulator stack)

Three terminals from the repo root. Requires Node 22 and a JDK on PATH
(emulators).

```bash
# 1. Firebase emulators (auth + firestore + storage), offline (demo- project)
npx firebase emulators:start --only auth,firestore,storage --project demo-antiphony

# 2. core-api on :8090, pointed at the emulators
PORT=8090 \
ANTIPHONY_USE_EMULATOR=true \
GCLOUD_PROJECT=demo-antiphony \
ANTIPHONY_APP_TOKENS=reference:reference-local-dev-token-0123456789abcdef \
ANTIPHONY_APP_DIDS=reference:did:web:your-domain.example \
SYSTEM_AUTH_TOKEN=local-dev-system-secret-12345678 \
  npm run dev -w @antiphony/core-api

# 3. the reference app on :3002
npm run dev -w @antiphony/reference
```

Open <http://localhost:3002>, record, and watch it round-trip
create → fetch → render. No sign-in step: the BFF asserts
`ANTIPHONY_ACTING_ACTOR` (default `reference-user`) as the author.

The token in step 2 must match `ANTIPHONY_SERVICE_TOKEN` in
`.env.development` — that pair is what lets the BFF authenticate. Both are
throwaway local values; a real deployment keeps the token in a secret store.

> **`ANTIPHONY_APP_DIDS` is required, and it needs a real domain.** It pins
> the tenant's `at://` authority, and core-api validates the pin by fetching
> `https://<domain>/.well-known/did.json` and requiring an `#atproto_pds`
> service entry. There is no offline substitute today — the resolve is
> HTTPS-only, so `did:web:localhost%3A8090` cannot work. Use a domain you
> control that serves a valid document (see
> [`specs/atproto-authority-model.md`](../../specs/atproto-authority-model.md)).
> Without the pin, boot *succeeds* and every post read/write then fails with
> `no validated app DID for tenant "reference"`.

## Run it (against the LIVE API)

Point the BFF at the deployed core-api instead of a local one — no emulator
stack needed:

```bash
# .env.production supplies the live URL; the token must come from your shell,
# since a live service token is a real secret and is not committed.
ANTIPHONY_SERVICE_TOKEN=<your live token> npm run dev:live -w @antiphony/reference

# or a production build + static preview:
npm run build -w @antiphony/reference
ANTIPHONY_SERVICE_TOKEN=<your live token> npm run preview -w @antiphony/reference
```

You can also put it in `.env.local` (gitignored) instead of the command line.
Without it the BFF returns a 500 naming what's missing, rather than forwarding
an unauthenticated request.

**No CORS caveat any more.** The browser only ever talks to its own origin, so
core-api's `ALLOWED_ORIGINS` — which deliberately excludes localhost in
production — no longer constrains this app. That restriction was the reason
the old browser-direct build couldn't run against the live API from localhost.

### Notes

- **Origin/tenancy**: `originAppId` is stamped server-side from the *service
  credential* the BFF presents — the app id half of the `appId:token` pair.
  Reads are scoped to the same key, so create → fetch round-trips within one
  core-api process automatically. (There is no `ANTIPHONY_ORIGIN_APP_ID`
  fallback; it was removed with the service-token migration.)
- **Author**: posts come back with an opaque `authorId` (whatever the BFF
  asserted), not a hydrated profile — core-api holds no user data. A real BFF
  joins display identity back on that id.
- **Transcript**: the embed view shows "No transcript yet" — transcript is
  async platform enrichment (`dev.antiphony.audio.transcript`), not produced
  by this flow. The view *lifts* it when it exists.
- **Signed audio URL**: playback uses the short-lived signed URL on
  `embed.url`. Signing needs real Google credentials, which the storage
  emulator has none of, so against a bare emulator stack the hydrator logs
  `failed to sign audio URL` and the view comes back with **no `embed` at
  all** — not merely an unplayable one. Create → fetch → viewer-state still
  validates; set `GOOGLE_APPLICATION_CREDENTIALS` to a service account if you
  need working playback locally.
- **After editing `@antiphony/shared`**: rebuild it
  (`npm run build -w @antiphony/shared`) — the app imports the built package,
  not the source.
