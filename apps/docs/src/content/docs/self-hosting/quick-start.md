---
title: Quick start
description: Run Vox Pop Core locally against the Firebase emulators.
---

This guide gets you from a fresh clone to a running `/api/v1/*` service against the Firebase emulators in about 5 minutes.

:::note
Firebase is the backend the core ships with today, so self-hosting currently means running against Firebase (or its emulators). Generalizing the core to support other backends is in progress; for now these steps assume Firebase.
:::

## Prerequisites

- **Node.js 22+**
- **Firebase CLI** — `npm install -g firebase-tools`
- (Optional) A Firebase project if you want to run against real Firebase instead of the emulators.

## 1. Clone and install

```bash
git clone https://github.com/bbthorson/vox-pop-core.git
cd vox-pop-core
npm install
```

## 2. Start the Firebase emulators

In one terminal:

```bash
npx firebase emulators:start --only auth,firestore,storage --project demo-vox-pop
```

The `demo-` project prefix tells the CLI not to require credentials — the emulators run entirely locally.

## 3. Start `core-api` in emulator mode

In a second terminal:

```bash
VOXPOP_USE_EMULATOR=true npm run dev -w @vox-pop/core-api
```

The service listens on `http://localhost:8080`. Smoke test:

```bash
curl http://localhost:8080/health
# → {"ok":true}

curl http://localhost:8080/
# → {"service":"vox-pop-core-api", ...}
```

## 4. Hit a real endpoint

Most `/api/v1/*` endpoints require an authenticated bearer token. For local exploration, mint an emulator ID token via the Firebase Auth emulator UI (`http://localhost:9099`), then:

```bash
curl http://localhost:8080/api/v1/users/me \
  -H "Authorization: Bearer $ID_TOKEN"
```

## Next steps

- Configure for production deploy — see [Configuration](/self-hosting/configuration/).
- Browse the full endpoint surface — see [API reference](/api/overview/).
