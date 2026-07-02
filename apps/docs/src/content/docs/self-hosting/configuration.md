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
