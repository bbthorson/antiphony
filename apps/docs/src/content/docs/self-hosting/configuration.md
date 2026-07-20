---
title: Configuration
description: Environment variables and deploy targets for Antiphony's core.
---

`apps/core-api` is a plain Node service configured entirely through environment variables. This page covers the full set, the emulator overrides, and the deploy targets.

Most of the variables below are Firebase credentials, because Firebase is the backend the core wires up today. As the backend is generalized, this set will grow to cover other providers; for now it reflects the Firebase-backed composition root.

## Core variables

| Variable | Purpose |
|---|---|
| `ANTIPHONY_ORIGIN_APP_ID` | The **fallback** tenancy key for end-user (Firebase-token) callers — the demo/reference path. Service-authenticated apps get their tenancy from their credential instead (see below). See [Multi-tenancy](/introduction/architecture/#multi-tenancy). |
| `FIREBASE_PROJECT_ID` | Firebase project to authenticate against. (`GCLOUD_PROJECT` is honored as a fallback when running on Google infrastructure.) |
| `FIREBASE_STORAGE_BUCKET` | GCS bucket for audio uploads. |
| `ADMIN_SERVICE_ACCOUNT_JSON` | Service account JSON for Firebase Admin (production). On Google infrastructure, Application Default Credentials are used instead. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist for browser-direct calls to `/api/v1/*`. Add every origin that calls the API from a browser — including any embed surface you deploy. Deliberately excludes `localhost` in production. |
| `PORT` | Port to bind. Defaults to `8080`; Cloud Run / App Hosting inject it automatically. |
| `LOG_LEVEL` | pino log level. Defaults to `info`. |
| `NODE_ENV` | Standard Node environment flag (`production` in deploys). |

## Emulator variables

For local development against the Firebase emulators (see [Quick start](/self-hosting/quick-start/)):

| Variable | Purpose |
|---|---|
| `ANTIPHONY_USE_EMULATOR` | When `true`, the composition root wires the emulator-backed clients instead of production Firebase. |
| `FIRESTORE_EMULATOR_HOST` | Firestore emulator address (e.g. `localhost:8080`). |
| `FIREBASE_AUTH_EMULATOR_HOST` | Auth emulator address (e.g. `localhost:9099`). |
| `FIREBASE_STORAGE_EMULATOR_HOST` | Storage emulator address. |

The Firebase Admin SDK reads the `*_EMULATOR_HOST` variables directly; `ANTIPHONY_USE_EMULATOR` gates the parts of the composition root the SDK doesn't cover.

## Service-to-service auth

Applications (BFFs, workers) are the intended callers of the posts/audio surface. Each authenticates with its own service token and asserts the acting end user per request — the full contract lives in [`specs/service-auth.md`](https://github.com/bbthorson/antiphony/blob/master/specs/service-auth.md).

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_TOKENS` | Comma-separated `appId:token` pairs (tokens ≥32 chars). A caller presenting a matching `Authorization: Bearer <token>` is that app: its tenancy (`originAppId`) comes from the credential, and it asserts the acting user via `X-Antiphony-Acting-Actor` (+ optional `X-Antiphony-Acting-Actor-Did`). Store as a secret. |
| `SYSTEM_AUTH_TOKEN` | Shared secret for the `/api/v1/system/*` routes. The system-auth middleware expects `Authorization: Bearer <SYSTEM_AUTH_TOKEN>` and **fails closed** (503) if the variable is unset — these routes are service-to-service plumbing, not public API. Store it as a secret, not in plaintext config. |

## Audio enrichment

Opt-in processing runs four stages over a post's audio: **denoise** and **transcribe** (external API — ElevenLabs), and **trim** and **waveform** (local compute — in-process ffmpeg). None run unless the relevant variables below are set; a deployment with none of them still serves audio, it just does no enrichment. Stages requested against a deployment that can't run them settle `skipped`, not `pending`.

### Providers

| Variable | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | Enables the ElevenLabs providers — Scribe (transcription) and Voice Isolator (denoise). **Presence alone selects them**; there is no separate enable flag. Absent → `denoise`/`transcribe` settle `skipped`. Store as a secret. |
| `ELEVENLABS_STT_MODEL` | Optional. Overrides the default Scribe model id used for transcription. |
| `ANTIPHONY_FFMPEG_PATH` | Optional. Path to an ffmpeg binary for the local-compute stages (`trim`, `waveform`). Defaults to the bundled `ffmpeg-static`; set this only to point at a system binary. Checked for executability at startup — a bad path means those stages advertise as unavailable rather than failing every post. |

### Dispatch

Processing runs out of band, never inside the create/patch request. How it's triggered depends on these:

| Variable | Purpose |
|---|---|
| `ANTIPHONY_TASKS_LOCATION` | Cloud Tasks region for durable dispatch (the production path), e.g. `us-east4`. |
| `ANTIPHONY_TASKS_QUEUE` | Cloud Tasks queue name. |
| `ANTIPHONY_TASKS_WORKER_URL` | Absolute URL of this deployment's `/api/v1/system/process-audio` worker route, which the queue calls back. Must carry `SYSTEM_AUTH_TOKEN` (above) — the worker is system-auth'd. |
| `ANTIPHONY_TASKS_PROJECT` | Optional. GCP project for the queue; falls back to `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`. |

The three non-optional `ANTIPHONY_TASKS_*` vars are **all-or-nothing**: set together, or a partial set is treated as a misconfiguration (logged at `error`, jobs dropped) rather than a silent opt-out. The runtime service account also needs `roles/cloudtasks.enqueuer`, and the worker route requires `SYSTEM_AUTH_TOKEN`.

### Stage-settled webhooks

Optional. When configured, the core POSTs a small signed webhook to a tenant's BFF each time an enrichment stage reaches a terminal state (`ready` / `failed` / `skipped`), so the BFF learns a result landed without polling. The webhook is a **latency accelerator over the authoritative post state**, not a second source of truth — a dropped delivery is a latency regression the next read reconciles, never lost data.

| Variable | Purpose |
|---|---|
| `ANTIPHONY_APP_WEBHOOK_URLS` | Comma-separated `appId:url` pairs — where to POST each tenant's stage-settled events, e.g. `vox-pop:https://bff.voxpop/hooks`. Split on the first colon, so a URL with a port is fine. |
| `ANTIPHONY_APP_WEBHOOK_SECRETS` | Comma-separated `appId:secret` pairs. The key for the `X-Antiphony-Signature: sha256=<hex>` header, an HMAC-SHA256 over the **raw request body**; the receiver recomputes and constant-time-compares. Store as a secret. |

A tenant present in **both** vars gets webhooks; a tenant in **neither** is a silent opt-out (the pull paths still work). A tenant in **exactly one** is a misconfiguration — logged at `error` and sent no webhooks, so it never pushes unsigned. Delivery is best-effort (a short timeout and a couple of retries); a failed POST is logged and swallowed, never failing the enrichment pass. The payload carries `{postId, originAppId, stage, status, occurredAt}` — enough to act on without a follow-up request; the artifact itself is fetched from the post view when wanted. Receivers should treat each event as "latest wins for `(postId, stage)`" (a recompute legitimately re-fires `ready`), using `occurredAt` as the tiebreaker.

### Development flags

| Variable | Purpose |
|---|---|
| `ANTIPHONY_PROCESSING_INLINE` | When `true`, runs processing **synchronously inside the request** — the local/test trigger, no queue needed. Wins over the Cloud Tasks vars, so a developer with queue config in their shell can't enqueue against a real queue by accident. |
| `ANTIPHONY_PROCESSING_STUB` | When `true`, wires pass-through **stub providers** instead of ElevenLabs — exercises the full create → process → hydrate loop with no key and no billing. Wins over `ELEVENLABS_API_KEY`, so a real key in the shell can't accidentally bill from a test run. |

With neither `ANTIPHONY_PROCESSING_INLINE` nor the `ANTIPHONY_TASKS_*` vars set, dispatch is a no-op (logged and dropped) — enrichment is effectively off.

## Deployment

The hosted reference deploy at `api.antiphony.dev` uses **Firebase App Hosting**. See `apphosting.yaml` at the repo root for the production config and [`apps/core-api/README.md`](https://github.com/bbthorson/antiphony/blob/master/apps/core-api/README.md) for deploy notes.

`core-api` is a plain Node service with no platform-specific dependencies, so other targets work too:

- **Cloud Run** — containerize the service, set the env vars as secrets/config, let `PORT` be injected.
- **Fly.io / Render / a VM** — `npm run build` then run the Node entrypoint; set `PORT` and the Firebase credentials.

Whatever the target, the only hard requirement is reachable Firebase credentials (or the emulator hosts) and a correct `ALLOWED_ORIGINS` for your browser clients.

## Where next?

- [Quick start](/self-hosting/quick-start/) — get it running locally first.
- [Build your own app](/build-your-own/overview/) — point a client at your deployment.
- [API reference](/api/overview/) — the surface your deployment exposes.
