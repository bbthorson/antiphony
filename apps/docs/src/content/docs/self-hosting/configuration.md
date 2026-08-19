---
title: Configuration
description: Environment variables and deploy targets for Antiphony's core.
---

`apps/core-api` runs on Cloudflare Workers and is configured through **bindings** and **environment values**. This page covers the full set and the deploy targets.

The distinction matters more than it looks:

- **Bindings** — the database, the R2 bucket, the queue, the KV namespace, the rate-limit Durable Object — are declared in [`apps/core-api/wrangler.jsonc`](https://github.com/bbthorson/antiphony/blob/master/apps/core-api/wrangler.jsonc) and authorised *by being bound*. There is no R2 key or service-account credential anywhere in that file, and a binding a deployment doesn't attach is a missing capability rather than a broken credential.
- **Values** are either non-secret `vars` in the same file, or **Worker secrets** set out of band with `wrangler secret put`. Everything below marked "store as a secret" is the second kind. Locally, both live in `apps/core-api/.dev.vars` (gitignored) — see the [quick start](/self-hosting/quick-start/#4-configure-and-start-core-api).

Under a Node host the same values are read from `process.env`, so nothing here is Workers-only syntax.

## Core variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string for records, transcripts, processing state, and idempotency keys. **Required** — the composition root throws rather than falling back. The SQL client runs `@neondatabase/serverless` over HTTP, so this must be a host that serves Neon's HTTP SQL endpoint; Neon's pooled (`-pooler`) host is the right one, since the driver is stateless per query. Store as a secret. |
| `ANTIPHONY_PUBLIC_BASE_URL` | **Required.** The absolute base URL this deployment answers on, e.g. `https://api.antiphony.dev`. The audio proxy streams bytes rather than redirecting, so `AudioEmbedView.url` is an absolute URL pointing back here — without this, a post with audio hydrates with no embed at all. |
| `ANTIPHONY_R2_BUCKET` | Name of the bucket behind the `BLOBS` binding. Used for logging and for the rendition service's own addressing, not for authorisation. |
| `TRUSTED_PROXY_HOPS` | Number of proxy hops to trust when deriving the client IP from `X-Forwarded-For`. Only the fallback rate-limit key uses the client IP now (see below), but a value that doesn't match your actual proxy depth still mis-attributes it. |
| `LOG_LEVEL` | One of `debug`, `info`, `warn`, `error`, `silent`. Defaults to `info` in production, `debug` otherwise. |
| `NODE_ENV` | Standard environment flag (`production` in deploys). |

:::note[There is no `ANTIPHONY_BACKEND` flag]
Which store backs the ports is decided by **which bindings are present**, not by a variable naming one. A deployment therefore cannot ask for Postgres and forget to attach the database. `GET /health` reports the answer as `backend`, alongside `records` and `blobs` presence signals — read those rather than `ok` alone when verifying a deployment.
:::

:::note[Removed: `ANTIPHONY_ORIGIN_APP_ID`]
Tenancy now comes exclusively from the caller's service credential. The deployment-level default was removed because inferring a tenant from an env var let an untrusted request read an arbitrary tenant's data. Setting it today has no effect.
:::

## Tenant identity

Every tenant needs **two** registry entries, and they're keyed on the same `originAppId`: a credential to authenticate with (`ANTIPHONY_APP_TOKENS`, below) and an app DID to write records under. A tenant present in only one is config drift — core-api logs a warning naming it.

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_DIDS` | Comma-separated `appId:did` pairs pinning each tenant's `at://` authority, e.g. `voxpop:did:web:did.voxpop.audio`. Split on the first colon, so the DID's own colons are safe. **Required for any tenant that reads or writes posts** — see the custody note below. |
| `ANTIPHONY_PDS_HOST` | Optional but recommended. Your Antiphony host (e.g. `api.antiphony.dev`). When set, a pin must also point its `#atproto_pds` `serviceEndpoint` at this host — that's what turns "the DID document exists" into "the DID names *us* as its PDS". Unset, core-api logs a warning and only requires the endpoint to be present. |

:::caution[Custody is proven per request, and fails closed]
Before any handler runs, the auth middleware resolves the caller's pinned `did:web` (`https://<domain>/.well-known/did.json`), checks the document's `id`, and requires an `#atproto_pds` service entry. A pin that doesn't validate **refuses the request with 503** — the core will not mint an `at://` URI whose authority it hasn't proven.

**Why per request rather than at boot.** A Worker has no boot phase to fail closed in, so the ordering guarantee has to be established somewhere a request passes through. The auth middleware already resolves `originAppId` and *is* the tenancy boundary, and a pin is a tenancy property. Three things keep the cost near zero: an isolate-local snapshot inside a freshness window, the shared `PIN_CACHE` KV namespace underneath it so a cold isolate doesn't re-resolve what another already proved, and a deploy-time gate (`npm run validate:pins`) that proves every pin in the config *before* it ships.

**503, not 401** — the caller's credential was fine. What failed is our ability to serve that tenant safely, which is a statement about us and is retryable. A 401 would send an integrator looking at their token.

The asymmetry to know about: an **empty** pin set is valid and starts cleanly, so a deployment with `ANTIPHONY_APP_TOKENS` but no `ANTIPHONY_APP_DIDS` looks healthy and then fails every post request with `no validated app DID for tenant "<id>"`. Because resolution is HTTPS-only, this can't be satisfied by a localhost domain — see the [quick start](/self-hosting/quick-start/#3-pin-your-tenants-app-did).
:::

Full rationale: [`specs/atproto-authority-model.md`](https://github.com/bbthorson/antiphony/blob/master/specs/atproto-authority-model.md).

## Service-to-service auth

Applications (BFFs, workers) are the intended callers of the posts/audio surface. Each authenticates with its own service token and asserts the acting end user per request — the full contract lives in [`specs/service-auth.md`](https://github.com/bbthorson/antiphony/blob/master/specs/service-auth.md).

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_TOKENS` | Comma-separated `appId:token` pairs (tokens ≥32 chars). A caller presenting a matching `Authorization: Bearer <token>` is that app: its tenancy (`originAppId`) comes from the credential, and it asserts the acting user via `X-Antiphony-Acting-Actor` (+ optional `X-Antiphony-Acting-Actor-Did`). Store as a secret. |
| `SYSTEM_AUTH_TOKEN` | Shared secret for the `/api/v1/system/*` routes. The system-auth middleware expects `Authorization: Bearer <SYSTEM_AUTH_TOKEN>` and **fails closed** (503) if the variable is unset — these routes are service-to-service plumbing, not public API. Store it as a secret, not in plaintext config. |

## Audio enrichment

Opt-in processing runs four stages over a post's audio: **denoise** and **transcribe** (ElevenLabs), and **trim** and **waveform** (ffmpeg, in the rendition service). None run unless the relevant variables below are set; a deployment with none of them still serves audio, it just does no enrichment. Stages requested against a deployment that can't run them settle `skipped`, not `pending`.

### Providers

| Variable | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | Enables the ElevenLabs providers — Scribe (transcription) and Voice Isolator (denoise). **Presence alone selects them**; there is no separate enable flag. Absent → `denoise`/`transcribe` settle `skipped`. Store as a secret. |
| `ELEVENLABS_STT_MODEL` | Optional. Overrides the default Scribe model id used for transcription. Not validated against a list of known ids — a typo reaches the provider and fails the stage — so the resolved value is logged on first use. |
| `ANTIPHONY_RENDITION_SERVICE_URL` | Base URL of the transcode backend ([`apps/audio-rendition`](https://github.com/bbthorson/antiphony/tree/master/apps/audio-rendition)). Enables `trim` and `waveform`, and lets `GET /api/v1/audio?format=mp3` build a rendition on a miss instead of 404ing. Absent is a **supported state**: both stages resolve unavailable and settle `skipped`, and the audio proxy serves only renditions that already exist. Requires `SYSTEM_AUTH_TOKEN` — the service is system-authed, so a URL without a token is the same failure wearing a 401. |

:::caution[A placeholder is not the same as absent]
The value is only checked for being non-empty. A URL like `https://…-REPLACE_ME.run.app` therefore counts as *configured*: every miss fetches a host that does not resolve, waits, logs `service unreachable`, and 404s anyway. This shipped to production for a day. If the URL needs to change, change it to a real one or **remove it** — never to a marker.
:::

#### Choosing a provider per stage

Optional, and rarely needed: with none of these set, each stage takes the first provider it can run, which is the behavior described above.

| Variable | Purpose |
|---|---|
| `ANTIPHONY_TRANSCRIBER` | `elevenlabs` \| `stub` |
| `ANTIPHONY_DENOISER` | `elevenlabs` \| `stub` |
| `ANTIPHONY_TRIMMER` | `service` \| `stub` |
| `ANTIPHONY_WAVEFORM` | `service` \| `stub` |

Naming a stage's provider explicitly lets you mix them — a real transcriber next to a stub denoiser while evaluating one of them, say. Two behaviors are worth knowing before you reach for these:

- **A named provider that isn't configured is a misconfiguration, not an opt-out.** `ANTIPHONY_TRANSCRIBER=elevenlabs` with no API key logs at `error` and leaves `transcribe` unavailable; it does **not** quietly fall back to another provider, on the same principle as the partial `ANTIPHONY_TASKS_*` set below.
- **`stub` is only ever reachable by naming it.** A deployment that loses its API key reports the stage as unavailable and settles requests `skipped` — it never degrades into saving stub transcripts as real records. For stubs across the board, use `ANTIPHONY_PROCESSING_STUB` (below), which overrides all four of these.

#### Choosing a provider or model per tenant

Optional. Pins one tenant (`originAppId`) to a provider or model of its own, leaving every other tenant on the deployment default. Same `appId:value` shape as [`ANTIPHONY_APP_DIDS`](#tenant-identity) and the webhook registries.

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_TRANSCRIBERS` | `voxpop:elevenlabs,acme:stub` |
| `ANTIPHONY_APP_DENOISERS` | same shape |
| `ANTIPHONY_APP_TRIMMERS` | same shape |
| `ANTIPHONY_APP_WAVEFORMS` | same shape |
| `ANTIPHONY_APP_STT_MODELS` | `voxpop:scribe_v2,acme:scribe_v1` — the transcription model per tenant |

Selection resolves in three layers, narrowest first: **tenant pin → deployment default → first available provider.** A tenant with no entry is unaffected by these existing at all.

- **This is ops config, not a tenant-facing feature.** A tenant cannot name its own provider or model over the API, so it can never invoke an arbitrary expensive model on your key. Changing a pin is a deploy, not a request.
- **A bad pin is scoped to its tenant.** An unknown or unconfigured provider name logs at `error` and leaves that stage unavailable **for that tenant only** — its neighbours keep working, and it does not fall back to the deployment default (which would silently overrule the pin). A malformed entry drops with a log without taking out the rest of the variable.
- **Capabilities are per tenant.** `processing` opt-ins settle `skipped` for a tenant whose pinned provider can't run, while the same request succeeds for a tenant on a working one.
- **A model pin aimed at a provider with no model is reported and ignored.** `denoise`, `trim`, and `waveform` have no model to set — only `ANTIPHONY_APP_STT_MODELS` exists for that reason. The stage still runs, on the provider's own default.

### Dispatch

Processing runs out of band, never inside the create/patch request.

**On Workers this is a binding, not a variable.** `PROCESSING_QUEUE` in `wrangler.jsonc` names a Cloudflare Queue whose consumer is the same Worker's `queue()` handler — so there is no worker URL to configure and no token stored per task. Batch size is deliberately **1**: one message is one full processing pass (a denoise call over a multi-megabyte upload, then transcription), the whole batch shares one 15-minute invocation, and blowing that budget retries every message in the batch including the ones that already succeeded. Concurrency belongs between invocations, where Cloudflare scales consumers on its own. Three attempts, then the dead-letter queue.

On a **Node host** the queue binding doesn't exist, and dispatch falls to the Cloud Tasks adapter instead:

| Variable | Purpose |
|---|---|
| `ANTIPHONY_TASKS_LOCATION` | Cloud Tasks region, e.g. `us-east4`. |
| `ANTIPHONY_TASKS_QUEUE` | Cloud Tasks queue name. |
| `ANTIPHONY_TASKS_WORKER_URL` | Absolute URL of this deployment's `/api/v1/system/process-audio` worker route, which the queue calls back. Must carry `SYSTEM_AUTH_TOKEN` (above) — the worker is system-auth'd. |
| `ANTIPHONY_TASKS_PROJECT` | Optional. GCP project for the queue; falls back to `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`. |

The three non-optional `ANTIPHONY_TASKS_*` vars are **all-or-nothing**: set together, or a partial set is treated as a misconfiguration (logged at `error`, jobs dropped) rather than a silent opt-out. The runtime service account also needs `roles/cloudtasks.enqueuer`.

### Stage-settled webhooks

Optional. When configured, the core POSTs a small signed webhook to a tenant's BFF each time an enrichment stage reaches a terminal state (`ready` / `failed` / `skipped`), so the BFF learns a result landed without polling. The webhook is a **latency accelerator over the authoritative post state**, not a second source of truth — a dropped delivery is a latency regression the next read reconciles, never lost data.

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_WEBHOOK_URLS` | Comma-separated `appId:url` pairs — where to POST each tenant's stage-settled events, e.g. `voxpop:https://bff.voxpop/hooks`. Split on the first colon, so a URL with a port is fine. Must be **https** unless the host is loopback (`localhost`, `127.0.0.1`, `::1`), which stays plaintext-friendly for developing a receiver locally. |
| `ANTIPHONY_APP_WEBHOOK_SECRETS` | Comma-separated `appId:secret` pairs, secrets **≥32 chars**. The key for the `X-Antiphony-Signature: sha256=<hex>` header, an HMAC-SHA256 over the **raw request body**; the receiver recomputes and constant-time-compares. Store as a secret. |

A tenant present in **both** vars gets webhooks; a tenant in **neither** is a silent opt-out (the pull paths still work). A tenant in **exactly one** is a misconfiguration — logged at `error` and sent no webhooks, so it never pushes unsigned. An entry that fails validation — a secret under the length floor, or a plaintext `http:` target off loopback — is dropped with an `error` log for that tenant alone, on the same fail-closed principle: the signature is the receiver's entire basis for trusting an event, so a key short enough to brute-force offline, or a hop where the payload and its signature both travel in the clear, makes it decorative. Delivery is best-effort (a short timeout and a couple of retries); a failed POST is logged and swallowed, never failing the enrichment pass. The payload carries `{postId, originAppId, stage, status, occurredAt}` — enough to act on without a follow-up request; the artifact itself is fetched from the post view when wanted. Receivers should treat each event as "latest wins for `(postId, stage)`" (a recompute legitimately re-fires `ready`), using `occurredAt` as the tiebreaker.

### Development flags

| Variable | Purpose |
|---|---|
| `ANTIPHONY_PROCESSING_INLINE` | When `true`, runs processing **synchronously inside the request** — the local/test trigger, no queue needed. Wins over every durable dispatcher, so a developer with queue config in their shell can't enqueue against a real queue by accident. |
| `ANTIPHONY_PROCESSING_STUB` | When `true`, wires pass-through **stub providers** instead of ElevenLabs — exercises the full create → process → hydrate loop with no key and no billing. Wins over `ELEVENLABS_API_KEY`, so a real key in the shell can't accidentally bill from a test run. |

With no queue binding, no `ANTIPHONY_PROCESSING_INLINE`, and no `ANTIPHONY_TASKS_*` vars, dispatch is a no-op (logged and dropped) — enrichment is effectively off. Note the two flags govern different axes and neither implies the other: `_STUB` decides which providers can do the work, `_INLINE` decides who runs it.

## Deployment

The hosted reference deploy at `api.antiphony.dev` runs on **Cloudflare Workers** against **Neon** and **R2**, configured by [`apps/core-api/wrangler.jsonc`](https://github.com/bbthorson/antiphony/blob/master/apps/core-api/wrangler.jsonc) and shipped by [`.github/workflows/deploy.yml`](https://github.com/bbthorson/antiphony/blob/master/.github/workflows/deploy.yml). See [`deploy/README.md`](https://github.com/bbthorson/antiphony/blob/master/deploy/README.md) for the one-time setup: the KV namespace and queues to create, the four Worker secrets, and the schema to apply.

The service layer is portable by construction — `packages/core` has zero backend imports and every backend touch goes through a port — so the reference deploy's choice of runtime is not a constraint on yours. What each target has to supply is a Postgres and a blob store behind the existing ports:

- **Cloudflare Workers** — Neon behind `DATABASE_URL`, plus an R2 bucket, a queue, a KV namespace and a Durable Object namespace. What the reference deploy runs.
- **A container or VM** — any Postgres and any object store. You implement the `BlobStore` port against it; the Postgres bindings are already in the tree.

The one hard requirement either way is a reachable Postgres. There is no CORS allowlist to configure: core-api runs no CORS middleware, because every caller is a backend holding a service token and the one browser-facing surface — the anonymous audio proxy — is an `<audio src=…>` no-cors load governed by `Cross-Origin-Resource-Policy`.

:::note[Why not Hyperdrive, and why not D1]
Two questions the reference deploy gets asked, both decided rather than defaulted.

**No Hyperdrive.** The SQL client runs `@neondatabase/serverless` in HTTP mode, which derives an HTTPS endpoint from the connection string's *hostname*. A Hyperdrive string points into Cloudflare's network, which serves no such endpoint — so binding Hyperdrive with this driver doesn't degrade the database, it breaks it outright. Adopting it means replacing the driver with one that speaks the wire protocol, behind the unchanged one-method `SqlClient` port. [Smart Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/) addresses the same geography problem from the other end and is on.

**Not D1, for the domain data.** The deciding argument is portability, not capability. The whole point of the ports is that a self-hoster can run this on their own stack; making the canonical store a Cloudflare-only one would invert the property they exist to protect. Postgres is the portable choice. Where Cloudflare-native storage *is* the better answer, it's used: rate-limit buckets are a Durable Object, and renditions are stored as nothing at all — the path is derivable and existence is an R2 `HEAD`.
:::

## Where next?

- [Quick start](/self-hosting/quick-start/) — get it running locally first.
- [Build your own app](/build-your-own/overview/) — point a client at your deployment.
- [API reference](/api/overview/) — the surface your deployment exposes.
