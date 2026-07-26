---
title: Quick start
description: Run Antiphony's core locally against the Firebase emulators.
---

This guide gets you from a fresh clone to a running `/api/v1/*` service against the Firebase emulators.

:::note
Firebase is the backend the core ships with today, so self-hosting currently means running against Firebase (or its emulators). Generalizing the core to support other backends is in progress; for now these steps assume Firebase.
:::

## Prerequisites

- **Node.js 22+** (not 25 — it breaks core-api's `tsx` dev runner)
- **A JDK on your PATH** — the Firebase emulators need it
- **Firebase CLI** — `npm install -g firebase-tools`
- **A domain you control**, serving a `did:web` document over HTTPS — see [step 3](#3-pin-your-tenants-app-did). This is the one prerequisite you can't fake locally.

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

## 3. Pin your tenant's app DID

Antiphony is the repo owner for the records it writes, so every post's `at://` URI is authored under a **tenant app DID** (`at://did:web:<your-domain>/dev.antiphony.audio.post/<rkey>` — see [the lexicons](/lexicons/overview/#how-faithful-is-this-to-at-protocol)). That DID is pinned per tenant via `ANTIPHONY_APP_DIDS`, and the core **proves custody of it at boot** before it will mint a single URI.

Serve this at `https://<your-domain>/.well-known/did.json`:

```json
{
  "id": "did:web:<your-domain>",
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://<your-antiphony-host>"
    }
  ]
}
```

:::caution[This step has no offline shortcut]
`did:web` resolution is **HTTPS-only** by specification, so `did:web:localhost%3A8090` cannot resolve, and there is no flag to skip the check. A purely local pin isn't possible today.

The failure mode is worth knowing, because it's quiet: an **empty** pin set passes the boot gate, so the process starts and looks healthy — then every post read and write fails with `no validated app DID for tenant "<id>"`. A *bad* pin is louder: boot fails closed and the process exits.
:::

Setting `ANTIPHONY_PDS_HOST` (step 4) tightens this further — with it, the core also requires the DID document's `serviceEndpoint` to point back at your deployment, not merely to exist.

## 4. Start `core-api` in emulator mode

In a second terminal. The Firestore emulator owns `:8080`, so bind core-api to `:8090`:

```bash
PORT=8090 \
ANTIPHONY_USE_EMULATOR=true \
GCLOUD_PROJECT=demo-antiphony \
ANTIPHONY_APP_TOKENS=local:a-local-dev-token-at-least-32-chars-long \
ANTIPHONY_APP_DIDS=local:did:web:your-domain.example \
  npm run dev -w @antiphony/core-api
```

Smoke test:

```bash
curl http://localhost:8090/health
# → {"ok":true,"sha":"dev","deployedAt":null}
```

Those two `local:` entries describe one tenant: `ANTIPHONY_APP_TOKENS` is the credential it authenticates with, `ANTIPHONY_APP_DIDS` is the `at://` authority it writes under. A tenant needs **both** — core-api warns at boot about a tenant configured in only one. Tenancy comes from the credential; there's no deployment-level default.

## 5. Hit a real endpoint

Every data route requires your **service token**. There's no end-user sign-in to do and no Firebase token involved: your app authenticates as itself and asserts which of *its* users is acting (see [Authentication](/api/overview/#authentication)).

```bash
TOKEN=a-local-dev-token-at-least-32-chars-long

# 1. Upload audio (returns a content-addressed blob ref to embed).
#    Max 25 MB, and the MIME type must be one core-api accepts.
curl -X POST http://localhost:8090/api/v1/audio/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: local-user-1" \
  -F "file=@your-clip.wav;type=audio/wav"
# → {"success":true,"data":{"blob":{"$type":"blob","ref":{"$link":"bafkrei…"},
#                                   "mimeType":"audio/wav","size":8044}}}

# 2. Create the post, with that blob ref as the embed's `audio`
curl -X POST http://localhost:8090/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: local-user-1" \
  -H "Content-Type: application/json" \
  -d '{ "text": "What should we cover next?",
        "embed": { "$type": "dev.antiphony.embed.audio", "audio": { …blob from above… } } }'
# → {"success":true,"data":{"postId":"3mrj6z52xwsj7"}}

# 3. Read it back, hydrated
curl "http://localhost:8090/api/v1/posts/3mrj6z52xwsj7" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: local-user-1"
```

The read returns the post under your pinned authority, with the acting actor stamped as the opaque `authorId`:

```json
{
    "uri": "at://did:web:your-domain.example/dev.antiphony.audio.post/3mrj6z52xwsj7",
    "cid": "bafyreifiw3szxfexpsmwy5fzeyqhu73zunk74pmeoqjjicysniki4sehgi",
    "kind": "prompt",
    "authorId": "local-user-1",
    "record": { "text": "What should we cover next?", "createdAt": "…" },
    "viewer": { "isAuthor": true, "canReply": true }
}
```

Note the acting-actor header on the read as well: it's what populates `viewer`. Drop it and you get the same post with an anonymous, viewer-less projection.

:::note[No `embed` in your local response?]
Expected against a bare emulator stack. `embed.url` is a **signed** Storage URL, and signing needs real Google credentials the storage emulator doesn't have — core-api logs `failed to sign audio URL` and omits the embed rather than returning an unplayable one. The create → fetch → viewer-state path still validates the contract. Point `GOOGLE_APPLICATION_CREDENTIALS` at a service account if you want working playback locally.
:::

The fastest way to see this loop in a browser is the [reference app](/build-your-own/reference-app/), which ships a small BFF that holds the token for you.

## Next steps

- Configure for production deploy — see [Configuration](/self-hosting/configuration/).
- Understand the records you're creating — see [The Antiphony lexicons](/lexicons/overview/).
- Browse the full endpoint surface — see [API reference](/api/overview/).
