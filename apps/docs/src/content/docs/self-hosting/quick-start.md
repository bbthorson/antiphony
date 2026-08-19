---
title: Quick start
description: Run Antiphony's core locally on the Workers runtime against a Postgres database.
---

This guide gets you from a fresh clone to a running `/api/v1/*` service on the same runtime the hosted deployment uses.

:::note[What changed]
Antiphony used to ship a Firestore-backed composition root and a Firebase-emulator quick start. It no longer does. The core runs on **Cloudflare Workers** against **Postgres** for records and an **R2 bucket** for audio blobs, and `wrangler dev` simulates the Cloudflare bindings on your machine — so there are no emulators to install and no JDK to have on your PATH. The one thing it cannot simulate is the database.
:::

## Prerequisites

- **Node.js 22+** (see `.nvmrc`)
- **A Postgres database reachable over HTTPS.** The SQL client is `@neondatabase/serverless` in HTTP mode, which POSTs to `https://<host>/sql` rather than opening a TCP connection — so a plain `localhost` Postgres will not answer it. A free [Neon](https://neon.tech) branch is the path of least resistance, and using a throwaway branch per developer is the intended shape.
- **A domain you control**, serving a `did:web` document over HTTPS — see [step 3](#3-pin-your-tenants-app-did). This is the one prerequisite you can't fake locally.

:::tip[Want a different Postgres?]
`SqlClient` is a one-method port. Pointing it at an ordinary wire-protocol driver (`pg`, `postgres.js`) is a single adapter file and lets any Postgres work, including a local one. See [Architecture § the seam that matters](/introduction/architecture/#the-seam-that-matters).
:::

## 1. Clone and install

```bash
git clone https://github.com/bbthorson/antiphony.git
cd antiphony
npm install
```

## 2. Create the database

Apply the schema to an empty database. It is one `begin`/`commit`, so a failed apply rolls back whole:

```bash
psql "$DATABASE_URL" -f apps/core-api/db/schema.sql
```

Four tables come out of it: `posts`, `audio_transcripts`, `idempotency_keys`, and `rate_limits`. Two properties are worth knowing because they are enforced rather than conventional — the query facets (`author_id`, `kind`, `cid`, …) are **generated columns** off the record JSON, so they cannot drift from it, and the "a reply has a parent and a root author; a prompt has neither" invariant is a **check constraint**, not just a Zod refinement.

:::caution[Apply-once DDL, not a migration chain]
Running it twice fails on `relation already exists` and changes nothing. There is no versioned migration tool yet.
:::

## 3. Pin your tenant's app DID

Antiphony is the repo owner for the records it writes, so every post's `at://` URI is authored under a **tenant app DID** (`at://did:web:<your-domain>/dev.antiphony.audio.post/<rkey>` — see [the lexicons](/lexicons/overview/#how-faithful-is-this-to-at-protocol)). That DID is pinned per tenant via `ANTIPHONY_APP_DIDS`, and the core **proves custody of it before any handler runs**.

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
`did:web` resolution is **HTTPS-only** by specification, so `did:web:localhost%3A8787` cannot resolve, and there is no flag to skip the check. A purely local pin isn't possible today.

The failure mode is worth knowing, because the two halves fail differently. An **unproven** pin fails the request with **503** — the credential was fine, our ability to serve that tenant safely is what's missing, and it's retryable. An **empty** pin set fails later and quieter: the service starts healthy and every post read and write returns `no validated app DID for tenant "<id>"`.
:::

Setting `ANTIPHONY_PDS_HOST` (step 4) tightens this further — with it, the core also requires the DID document's `serviceEndpoint` to point back at your deployment, not merely to exist.

## 4. Configure and start `core-api`

Worker secrets are not environment variables, so local config goes in `apps/core-api/.dev.vars` (gitignored) rather than your shell. Create it:

```bash
# apps/core-api/.dev.vars
DATABASE_URL="postgresql://…@ep-….neon.tech/neondb?sslmode=require"
ANTIPHONY_APP_TOKENS="local:a-local-dev-token-at-least-32-chars-long"
ANTIPHONY_APP_DIDS="local:did:web:your-domain.example"
ANTIPHONY_PUBLIC_BASE_URL="http://localhost:8787"
```

Then:

```bash
npm run dev
```

That runs `wrangler dev`, which serves on `http://localhost:8787` and simulates the R2 bucket, the KV namespace, the queue, and the rate-limit Durable Object locally. Smoke test:

```bash
curl http://localhost:8787/health
# → {"ok":true,"sha":"dev","deployedAt":null,
#    "backend":"postgres","records":"empty","blobs":"empty"}
```

Read `backend` and the two presence fields rather than `ok` alone. `ok:true` is true of any process that started; `backend` says which store you are actually talking to, and `records`/`blobs` say whether it has anything in it — which is the question that went unanswered for twenty minutes during the production cutover while `/health` reported a cheerful `ok:true` over an empty database and an empty bucket.

`ANTIPHONY_PUBLIC_BASE_URL` is required, not cosmetic: the audio proxy streams bytes rather than redirecting, so `AudioEmbedView.url` is an absolute URL pointing back at this service. Without it, a post with audio hydrates with no embed at all.

Those two `local:` entries describe one tenant: `ANTIPHONY_APP_TOKENS` is the credential it authenticates with, `ANTIPHONY_APP_DIDS` is the `at://` authority it writes under. A tenant needs **both** — core-api warns about a tenant configured in only one. Tenancy comes from the credential; there's no deployment-level default.

## 5. Hit a real endpoint

Every data route requires your **service token**. There's no end-user sign-in to do: your app authenticates as itself and asserts which of *its* users is acting (see [Authentication](/api/overview/#authentication)).

```bash
TOKEN=a-local-dev-token-at-least-32-chars-long

# 1. Upload audio (returns a content-addressed blob ref to embed).
#    Max 25 MB, and the MIME type must be one core-api accepts.
curl -X POST http://localhost:8787/api/v1/audio/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: local-user-1" \
  -F "file=@your-clip.wav;type=audio/wav"
# → {"success":true,"data":{"blob":{"$type":"blob","ref":{"$link":"bafkrei…"},
#                                   "mimeType":"audio/wav","size":8044}}}

# 2. Create the post, with that blob ref as the embed's `audio`
curl -X POST http://localhost:8787/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Antiphony-Acting-Actor: local-user-1" \
  -H "Content-Type: application/json" \
  -d '{ "text": "What should we cover next?",
        "embed": { "$type": "dev.antiphony.embed.audio", "audio": { …blob from above… } } }'
# → {"success":true,"data":{"postId":"3mrj6z52xwsj7"}}

# 3. Read it back, hydrated
curl "http://localhost:8787/api/v1/posts/3mrj6z52xwsj7" \
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

:::note[Playback works locally now]
`embed.url` used to be a signed Cloud Storage URL, which meant local playback needed real Google credentials the storage emulator couldn't provide, and the embed was omitted rather than returned unplayable. It is now the **audio proxy** — `GET /api/v1/audio?url=blobs/…`, which streams the bytes out of the bucket — so `wrangler dev`'s simulated R2 serves it like any other object, with no credentials involved.

Two enrichment stages still need something you don't have locally: `trim` and `waveform` run in [`apps/audio-rendition`](https://github.com/bbthorson/antiphony/tree/master/apps/audio-rendition) over HTTP, so without `ANTIPHONY_RENDITION_SERVICE_URL` they resolve unavailable and settle `skipped`. That's the honest state, not a failure — see [Configuration § audio enrichment](/self-hosting/configuration/#audio-enrichment).
:::

The fastest way to see this loop in a browser is the [reference app](/build-your-own/reference-app/), which ships a small BFF that holds the token for you.

## Next steps

- Configure for production deploy — see [Configuration](/self-hosting/configuration/).
- Understand the records you're creating — see [The Antiphony lexicons](/lexicons/overview/).
- Browse the full endpoint surface — see [API reference](/api/overview/).
