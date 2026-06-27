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
# 1. Firebase emulators (auth + firestore + storage), fully offline (demo- project)
npx firebase emulators:start --only auth,firestore,storage --project demo-antiphony

# 2. core-api on :8090, pointed at the emulators
PORT=8090 \
ANTIPHONY_USE_EMULATOR=true \
GCLOUD_PROJECT=demo-antiphony \
ANTIPHONY_ORIGIN_APP_ID=reference \
ALLOWED_ORIGINS=http://localhost:3002 \
SYSTEM_AUTH_TOKEN=local-dev-system-secret-12345678 \
  npm run dev -w @antiphony/core-api

# 3. the reference app on :3002 (pre-allowlisted in core-api's CORS fallback)
npm run dev -w @antiphony/reference
```

Open <http://localhost:3002>. The app signs in anonymously against the auth
emulator (no setup needed), records audio, uploads it, creates a post, then
fetches and renders the hydrated `AudioPostView`.

## Run it (against the LIVE API)

To point the app at the deployed `antiphony-core` core-api and real Firebase
Auth instead of the emulator — no local stack needed:

```bash
npm run dev:live -w @antiphony/reference   # HMR dev server on :3002, live config
# or a production build + static preview:
npm run build -w @antiphony/reference && npm run preview -w @antiphony/reference
```

Both load `.env.production`, which targets the live API and uses the real
(non-secret, public) Firebase web `apiKey`. Anonymous sign-in hits real
Firebase Auth (the **Anonymous** provider must be enabled on the project).

**CORS caveat:** the production backend's `ALLOWED_ORIGINS` deliberately
excludes localhost (prod must never accept credentialed requests from
localhost). So `localhost:3002` → live API is CORS-blocked out of the box.
To run local-against-live, either temporarily add `http://localhost:3002` to
the backend's `ALLOWED_ORIGINS` (apphosting.yaml), or — the real path —
deploy this app to an allowlisted origin (e.g. `reference.antiphony.dev`) and
add that origin to `ALLOWED_ORIGINS`.

Until the `api.antiphony.dev` TLS cert finishes provisioning, swap
`VITE_CORE_API_BASE_URL` to the `…hosted.app` fallback noted in
`.env.production`.

### Notes

- **Origin/tenancy**: the post's `originAppId` is stamped server-side from
  `ANTIPHONY_ORIGIN_APP_ID`; reads are scoped to the same key, so a single
  core-api process round-trips create→fetch automatically.
- **Transcript**: the embed view shows "No transcript yet" — transcript is
  async platform enrichment (`dev.antiphony.audio.transcript`), not produced
  by this flow. The view *lifts* it when it exists.
- **Signed audio URL**: playback uses the short-lived signed URL on
  `embed.url`. If the storage emulator can't sign a working URL in your
  environment, the create→fetch→viewer-state path still validates the
  contract; only inline playback is affected.
- **After editing `@antiphony/shared`**: rebuild it
  (`npm run build -w @antiphony/shared`) — the app imports the built package,
  not the source.
