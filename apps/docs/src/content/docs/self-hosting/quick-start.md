---
title: Quick start
description: Run Antiphony's core locally against the Firebase emulators.
---

This guide gets you from a fresh clone to a running `/api/v1/*` service against the Firebase emulators in about 5 minutes.

:::note
Firebase is the backend the core ships with today, so self-hosting currently means running against Firebase (or its emulators). Generalizing the core to support other backends is in progress; for now these steps assume Firebase.
:::

## Prerequisites

- **Node.js 22+** (not 25 — it breaks core-api's `tsx` dev runner)
- **A JDK on your PATH** — the Firebase emulators need it
- **Firebase CLI** — `npm install -g firebase-tools`

## 1. Clone and install

```bash
git clone https://github.com/bbthorson/antiphony.git
cd antiphony
npm install
```

## 2. Start the Firebase emulators

In one terminal:

```bash
npx firebase emulators:start --only auth,firestore,storage --project demo-antiphony
```

The `demo-` project prefix tells the CLI not to require credentials — the emulators run entirely locally.

## 3. Start `core-api` in emulator mode

In a second terminal. The Firestore emulator owns `:8080`, so bind core-api to `:8090`:

```bash
PORT=8090 \
VOXPOP_USE_EMULATOR=true \
GCLOUD_PROJECT=demo-antiphony \
ANTIPHONY_ORIGIN_APP_ID=local \
  npm run dev -w @antiphony/core-api
```

Smoke test:

```bash
curl http://localhost:8090/health
# → {"ok":true}
```

`ANTIPHONY_ORIGIN_APP_ID` is the tenancy key every post is stamped with — reads are scoped to the same value (see [Multi-tenancy](/introduction/architecture/#multi-tenancy)).

## 4. Hit a real endpoint

Most `/api/v1/*` endpoints require an authenticated bearer token. For local exploration, mint an emulator ID token via the Firebase Auth emulator UI (`http://localhost:9099`), then create an audio post:

```bash
# 1. Upload audio (returns a storage ref to embed)
curl -X POST http://localhost:8090/api/v1/audio/upload \
  -H "Authorization: Bearer $ID_TOKEN" \
  -F file=@your-clip.wav

# 2. Create the post with that audio in its embed
curl -X POST http://localhost:8090/api/v1/posts \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "text": "What should we cover next?", "embed": { ... } }'

# 3. Read it back (hydrated view with a signed audio URL)
curl http://localhost:8090/api/v1/posts/POST_ID \
  -H "Authorization: Bearer $ID_TOKEN"
```

The fastest way to see this loop end to end is the [reference app](/build-your-own/reference-app/), which signs in anonymously and drives record → upload → create → render with no manual token wrangling.

## Next steps

- Configure for production deploy — see [Configuration](/self-hosting/configuration/).
- Understand the records you're creating — see [The Antiphony lexicons](/lexicons/overview/).
- Browse the full endpoint surface — see [API reference](/api/overview/).
