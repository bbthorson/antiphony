# Deploying Antiphony

Three things deploy from this repo:

| What | Where | Workflow |
| :--- | :--- | :--- |
| `apps/core-api`, the API | Cloudflare Worker `antiphony-core-api`, at `api.antiphony.dev` | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), on every push to `master` that touches the service |
| `apps/audio-rendition`, the ffmpeg service | Cloud Run `antiphony-audio-rendition` (`us-east4`, project `antiphony-core`) | [`.github/workflows/deploy-audio-rendition.yml`](../.github/workflows/deploy-audio-rendition.yml) |
| `apps/docs`, the docs site | Cloudflare Worker `antiphony-docs`, at `docs.antiphony.dev` | [`.github/workflows/deploy-docs.yml`](../.github/workflows/deploy-docs.yml), after CI passes on `master` |

This file is the runbook for the one-time setup those workflows assume. The core-api config
is [`apps/core-api/wrangler.jsonc`](../apps/core-api/wrangler.jsonc), which explains each
binding.

---

## 1. Cloudflare resources

`wrangler deploy` fails on a config that names a resource that doesn't exist. That's useful:
a missing binding is caught before a deploy, not at the first request that needs it.

```bash
# The shared layer of the app-DID custody cache.
npx wrangler kv namespace create PIN_CACHE

# Audio processing. Create the dead-letter queue before the consumer that names it.
npx wrangler queues create antiphony-processing
npx wrangler queues create antiphony-processing-dlq

# Audio blobs.
npx wrangler r2 bucket create antiphony-r2-bucket
```

Put the KV id in `apps/core-api/wrangler.jsonc` and commit it. Ids identify resources; they
aren't credentials. Queues are bound by name, so their ids are recorded only here. For the
production account (`dd03fe171a20e2a1728b90c2f16ae4f4`, created 2026-08-17):

| Resource | Id |
| :--- | :--- |
| `PIN_CACHE` KV namespace | `7bdd861a89e7499d9a52366e8fa5d393` |
| `antiphony-processing` | `83b13d87b09b4ded940cae4a914f173a` |
| `antiphony-processing-dlq` | `d3da1758e098419490fec45ea12da07b` |

**There is no Hyperdrive binding, on purpose.** core-api's SQL client is
`@neondatabase/serverless` in HTTP mode, which derives an HTTPS endpoint from the connection
string's host. A Hyperdrive string points into Cloudflare's network, not at Neon, and
`readRuntimeEnv` prefers Hyperdrive when it's bound, so adding one would break the database.
The database is a Worker secret instead (§2). Moving to Hyperdrive means replacing the driver,
not adding a binding ([`specs/archive/cloudflare-migration.md`](../specs/archive/cloudflare-migration.md),
"Verified deploy blockers").

## 2. Worker secrets

None of these appears in a committed file. Each `secret put` reads the value from stdin, so
nothing lands in a file or in shell history.

```bash
cd apps/core-api
npx wrangler secret put SYSTEM_AUTH_TOKEN
npx wrangler secret put ANTIPHONY_APP_TOKENS
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put DATABASE_URL
npx wrangler secret put RENDITION_SERVICE_TOKEN         # optional
npx wrangler secret put ANTIPHONY_SERVICE_SIGNING_KEY   # optional, see below
```

- **`DATABASE_URL`** is Neon's **pooled** (`-pooler`) connection string, the one real database
  credential the Worker holds.
- **`RENDITION_SERVICE_TOKEN`** (optional) is a bearer just for calls to audio-rendition, so it
  can be rotated apart from `SYSTEM_AUTH_TOKEN`.
- **R2 needs no secret.** A binding authorizes by being bound.
- **`ANTIPHONY_APP_DIDS` is a var, not a secret.** DIDs are public, and keeping the pins in the
  config is what lets the deploy prove them without access to anything secret.
- **`ANTIPHONY_SERVICE_SIGNING_KEY`** (optional) publishes Antiphony's own DID document at
  `/.well-known/did.json`. Set the secret first, then the public key:

  ```bash
  npm run generate:service-key -w @antiphony/core-api   # prints both values; writes nothing
  npx wrangler secret put ANTIPHONY_SERVICE_SIGNING_KEY -c apps/core-api/wrangler.jsonc
  # then put the printed public key in "vars" in apps/core-api/wrangler.jsonc as
  # ANTIPHONY_SERVICE_PUBLIC_KEY, and deploy
  ```

  The route answers only when the secret derives the var. With either one missing it stays a
  404, so the document never advertises a key the service doesn't hold. Keep the private key
  in a password manager and nowhere else.

Cloudflare secrets can't be read back. That's why the schema apply (§4) runs from a shell
with its own copy of `DATABASE_URL`.

## 3. GitHub settings

| Kind | Name | Value |
| :--- | :--- | :--- |
| Secret | `CLOUDFLARE_API_TOKEN` | An API token with the permissions below |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | The account id |
| Variable | `R2_ACCOUNT_ID` | The same account id, read by the audio-rendition deploy |

**Put the account ids under Variables, not Secrets.** `secrets.FOO` and `vars.FOO` are separate
namespaces in Actions. An id added as a secret leaves `vars.CLOUDFLARE_ACCOUNT_ID` empty while
the settings page looks complete.

**The token needs more than `Workers Scripts:Edit`.** `wrangler deploy` checks every binding
in the config against the API before it uploads anything, and stops at the first one that
fails. Grant the whole set at once, or a too-narrow token reveals its gaps one red build at a
time:

| Account permission | Why |
| :--- | :--- |
| `Workers Scripts:Edit` | Upload the script |
| `Workers R2 Storage:Edit` | The `BLOBS` binding |
| `Workers KV Storage:Edit` | The `PIN_CACHE` binding |
| `Queues:Edit` | The producer and consumer bindings |
| `Account Settings:Read` | Account lookup during deploy |

Also grant `User → Memberships:Read` and `User → User Details:Read`; without them deploys warn
but don't fail. `Zone → Workers Routes:Edit` is needed only if routes move into the config (the
route in §7 was added in the dashboard). A bad binding fails with `Authentication error
[code: 10000]` on that resource. A missing token fails before any binding is checked, so check
the token first.

## 4. Database schema

```bash
DATABASE_URL="$DATABASE_URL" npm run migrate -w @antiphony/core-api -- --dry-run   # what's pending
DATABASE_URL="$DATABASE_URL" npm run migrate -w @antiphony/core-api
```

Migrations are a numbered chain in `apps/core-api/migrations/*.sql`. Each file is applied in
its own transaction and recorded with a checksum in `schema_migrations`, so an applied file
can't be edited. In production, the `Deploy core-api` workflow applies pending migrations before
it deploys. A self-hosted deployment has to run them itself. A database that already has the
schema from before the chain existed (applied with `psql -f db/schema.sql`) has to be
baselined once first, always with `--until` naming the last file it already has. See
[`apps/core-api/db/README.md`](../apps/core-api/db/README.md).

`ANTIPHONY_PDS_HOST` (a var in `wrangler.jsonc`) is required: the Worker refuses to start
without it (`assertRequiredConfig`). Outside the Worker, in tests or a local harness, a missing
value makes `/api/v1/dids` answer `503 DIDS_UNAVAILABLE` and writes under a registered DID
answer `503 AUTHORITY_CUSTODY_UNPROVEN`. Without an expected host, a tenant could register
anyone's DID.

## 5. audio-rendition (optional)

`apps/audio-rendition` derives `mp3` renditions for callers that can't decode webm/opus.
Twilio's `<Play>` is the one that matters. It's a container, not a Worker, because it spawns
ffmpeg. See [`apps/audio-rendition/README.md`](../apps/audio-rendition/README.md).

**You can skip it.** Without it, `GET /api/v1/audio?format=mp3` serves renditions that already
exist and 404s the rest. If you skip it, **delete `ANTIPHONY_RENDITION_SERVICE_URL`** from the
vars rather than leaving a placeholder. `renditionServiceConfig()` only checks that the var is
non-empty, so a placeholder counts as configured and every miss fetches a host that doesn't
resolve.

The deploy needs three Secret Manager secrets (`system-auth-token`, `r2-access-key-id`,
`r2-secret-access-key`) and the `R2_ACCOUNT_ID` repo variable. The R2 key is the **one stored R2
credential in Antiphony**, because everything else reaches R2 through a binding. Scope it to
`antiphony-r2-bucket`.

**IAM, all learned by running it:**

1. **`github-deploy@` needs `roles/iam.serviceAccountUser` on the runtime service account it
   deploys as**, `antiphony-core-api@`. The grant is per service account:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     antiphony-core-api@antiphony-core.iam.gserviceaccount.com \
     --member "serviceAccount:github-deploy@antiphony-core.iam.gserviceaccount.com" \
     --role roles/iam.serviceAccountUser --project antiphony-core
   ```

   An earlier grant on the default compute account (`636106936349-compute@`) doesn't carry
   over. Revoke it if nothing else needs it.
2. **The runtime account needs `roles/secretmanager.secretAccessor` on each secret.** Without
   it, Cloud Run refuses the revision at start. The service then exists in the console but
   serves nothing, which looks like a broken container rather than a missing grant.
3. **The workflow passes `--service-account` on purpose.** Otherwise the revision runs as the
   default compute account, which holds `roles/editor` on the whole project. That's the widest
   blast radius possible, for the one container that shells out to ffmpeg and holds R2 keys.

Then set `ANTIPHONY_RENDITION_SERVICE_URL` in `wrangler.jsonc` to the service's URL. That's Cloud
Run's opaque hostname:

```bash
gcloud run services describe antiphony-audio-rendition \
  --project antiphony-core --region us-east4 --format='value(status.url)'
```

The URL and `SYSTEM_AUTH_TOKEN` (or `RENDITION_SERVICE_TOKEN`) go together. A URL with no token
401s on every miss, and core-api logs that once at startup.

**To check it works,** ask for an mp3 of a CID that doesn't exist. The service should log
`[rendition] no source` at `warn` and answer 404, which means R2 authenticated and reported a
missing object. A bad key logs `read failed (403)` at `error`. `/health` doesn't touch R2, so
a green health check proves nothing about the credentials.

## 6. Deploy core-api

Push to `master`, or run the workflow by hand. It proves every app-DID pin (`validate:pins`),
checks the Worker bundle has no Node-only dependency, applies pending migrations, deploys,
and smoke-tests `/health`.

**The smoke test matches `/health`'s `sha` against `GITHUB_SHA`,** not `"ok": true`. Any healthy
deployment at that hostname says `ok`, including a stale one. The one gap: a manual re-run of
the same commit is satisfied by the previous deploy of it.

**When `Deploy` fails, GitHub skips the smoke test.** So the step whose job is to say "live is
not what you merged" doesn't run. Read a red `Deploy` as the signal; a green run with a skipped
smoke test is not a deploy.

From a laptop:

```bash
npm run deploy -w @antiphony/core-api
```

## 7. Domain

`api.antiphony.dev/*` is a route on the `antiphony-core-api` Worker (Workers & Pages → the
Worker → Settings → Domains & Routes). Both sides are Cloudflare, so there's no origin to reach
around.

```bash
curl -s https://api.antiphony.dev/health
```

`/health` answers without a credential. It reports `sha`, `deployedAt`, the wired `backend`
(always `postgres` now), and whether Neon and R2 actually hold data. `ok` stays `true` for an
empty deployment, so read the fields, not the status code.

**`workers.dev` is on.** The config sets no `workers_dev` key, and the default is enabled. So the
Worker also answers at `antiphony-core-api.bbthorson.workers.dev`. Every route but `/health`
still needs a token, so it isn't a hole, but edge settings for `api.antiphony.dev` don't apply
there. Set `"workers_dev": false` to close it.

---

## 8. The docs site

`docs.antiphony.dev` is a separate, assets-only Worker, **`antiphony-docs`**. It has no bindings
and no script, and serves the static Astro build of `apps/docs`. Its config is
[`wrangler.jsonc`](../wrangler.jsonc) at the repo root, so the root config must stay the docs
site's; core-api's is always passed with `-c`.

| Setting | Value |
| :--- | :--- |
| Build command | `npm run build -w @antiphony/docs` |
| Deploy command | `npx wrangler deploy` (from the repo root) |

- **`name` in the root `wrangler.jsonc` must equal the Worker's name, `antiphony-docs`.**
  Cloudflare's autofix once "corrected" it to `antiphony`, and that was wrong. When the dashboard
  shows the "keep settings consistent" banner, take the name from the banner (it quotes the
  live Worker), not from an autofix PR.
- **Deploys come from GitHub Actions only.** The Cloudflare Workers Builds connection was
  removed so failures show up in Actions. Keep the Git repository disconnected in the dashboard
  so it doesn't deploy twice.
- **A docs build runs a full workspace install,** so anything that breaks `npm ci` at the root
  breaks the docs deploy too.

### Node version

`.nvmrc` pins an exact patch (`22.23.2`), and every workflow reads it through
`actions/setup-node`, so a bump moves CI and every deploy together. It's exact because Cloudflare's
build image only preinstalls a few versions. A bare `22` resolves to the newest release, which
may need a download that has failed before. `apps/audio-rendition/Dockerfile` pins `node:22-slim`
separately.

Node 22 is in maintenance until 2027-04-30. Node 24 is the active LTS. The full gate passed on
24.18.0 on 2026-08-19, so the move is pre-validated. Bump `.nvmrc`, the Dockerfile and the root
`engines` together.

---

## Rollback

- **A bad deploy:** roll back in the dashboard (Workers & Pages → the Worker → Deployments), or
  `npx wrangler rollback`. It's instant and needs no rebuild.
- **Bad data:** use Neon's own recovery, a point-in-time restore or a restore onto a branch.
  There is no other store to fall back to; `composition.ts` throws rather than run without its
  bindings.

## Operational notes

- **The TTL sweep** runs hourly from the Worker's cron trigger (`17 * * * *`) and calls
  `antiphony_sweep_expired()`. It only reclaims space, since both upserts already treat an
  expired row as absent. It can run late or not at all without anything visible changing. To
  run it by hand: `select * from antiphony_sweep_expired();`.
- **Pin drift** is reported on the same trigger, before the sweep. A tenant whose DID document
  stops naming Antiphony logs at `error`, and fails closed at its next request. DIDs registered
  through `/api/v1/dids` are rechecked the same way.
- **The remote-post sweep** runs on the same trigger too
  ([`specs/audio-service-mode.md`](../specs/audio-service-mode.md) §8.1).
- **Latency.** Neon is single-region (AWS `us-east-1`) and Workers run near the user, so Smart
  Placement is on. The regression it prevents can't be seen when testing from the US east coast,
  which is why it was on from the first deploy rather than added after measuring.

## History

core-api ran on Firebase App Hosting, then Cloud Run with Firestore and Cloud Storage, and moved
to Workers, Neon and R2 on 2026-08-17. Nothing in core-api talks to Google Cloud or Firebase
now. Firestore never held any `/api/v1/posts` records, so the move copied only blobs (with
Cloudflare Super Slurper; object paths are content-addressed and didn't change). The Cloud Run
runbook and the Firestore migration script are in this file's and the repo's git history. The
reasoning is in [`specs/archive/cloudflare-migration.md`](../specs/archive/cloudflare-migration.md).
