# Cloudflare Workers deploy — one-time setup

`apps/core-api` runs on Cloudflare Workers. `.github/workflows/deploy.yml`
deploys it on every push to `master` that touches the service; everything here
is the setup that workflow assumes.

The config it applies is [`apps/core-api/wrangler.jsonc`](../apps/core-api/wrangler.jsonc),
which carries the reasoning for each binding. This file is the runbook.

> **This replaced a Cloud Run deployment**, which had itself replaced Firebase
> App Hosting. The Cloud Run runbook that used to live here — Artifact Registry,
> two service accounts, Workload Identity Federation, a `--no-traffic` →
> smoke-test → promote sequence, a `Host` header rewrite, and an origin lock — is
> gone with the runtime. Most of it existed to contain a fail-closed boot gate
> that no longer exists either; see
> [`specs/cloudflare-migration.md`](../specs/cloudflare-migration.md) § The boot
> gate. If you need the old procedure, it is in this file's git history.

---

## 1. Create the resources the config names

Four, and `wrangler deploy` fails on a config naming any that does not exist —
which is the point: a missing binding is caught before a deploy rather than at
the first request that needs it.

> ⛔ **Do not create the Hyperdrive config yet.** `core-api`'s SQL client is
> `@neondatabase/serverless` in HTTP mode, which derives an HTTPS endpoint from
> the connection string's hostname — and a Hyperdrive string points into
> Cloudflare's network, not at Neon. Since `readRuntimeEnv` PREFERS Hyperdrive
> when bound, binding it with the current driver breaks the database entirely.
> See § Verified deploy blockers in
> [`specs/cloudflare-migration.md`](../specs/cloudflare-migration.md) for the two
> ways out. Until one is chosen, set the database as a Worker secret instead:
>
>     npx wrangler secret put DATABASE_URL -c apps/core-api/wrangler.jsonc
>
> and remove the `hyperdrive` block from `apps/core-api/wrangler.jsonc`. Neon's
> pooled (`-pooler`) host is correct for that; the direct host is what Hyperdrive
> would want, if and when it is used.

```bash
# The shared layer of the app-DID custody cache.
npx wrangler kv namespace create PIN_CACHE

# Audio processing. The dead letter queue must exist before the consumer that
# names it.
npx wrangler queues create antiphony-processing
npx wrangler queues create antiphony-processing-dlq
```

Each prints an id. Put them in `apps/core-api/wrangler.jsonc` in place of the
`REPLACE_ME_…` placeholders and commit that — ids are per-account identifiers,
not credentials.

The GCP side of `apps/audio-rendition` needs one more grant that the workflow's
header does not mention, found by running it: `github-deploy@` must be able to
act as the Cloud Run runtime service account, or `gcloud run deploy` fails with
`Permission 'iam.serviceaccounts.actAs' denied`.

```bash
gcloud iam service-accounts add-iam-policy-binding \
  636106936349-compute@developer.gserviceaccount.com \
  --member "serviceAccount:github-deploy@antiphony-core.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountUser --project antiphony-core
```

The R2 bucket (`antiphony-r2-bucket`) is created in the dashboard, or with
`npx wrangler r2 bucket create antiphony-r2-bucket`.

## 2. Secrets

Three, and none of them appears in any committed file. Cloudflare secrets are
write-only from outside — nothing reads one back — which is exactly why the
schema apply in step 4 and the blob migration in step 5 cannot use them: those
run in a shell, against Neon and GCS, with no Worker involved.

```bash
cd apps/core-api
npx wrangler secret put SYSTEM_AUTH_TOKEN
npx wrangler secret put ANTIPHONY_APP_TOKENS
npx wrangler secret put ELEVENLABS_API_KEY
```

**Not** the database (Hyperdrive holds it) and **not** R2 (binding-based
authorisation needs no credential). `ANTIPHONY_APP_DIDS` is deliberately a
`var` rather than a secret: DIDs are public, and keeping it in the config is
what lets the deploy gate prove the pins without access to anything secret.

## 3. GitHub

| Kind | Name | Value |
| :--- | :--- | :--- |
| Secret | `CLOUDFLARE_API_TOKEN` | API token with **Workers Scripts:Edit** |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Account id — an identifier, not a credential |
| Variable | `R2_ACCOUNT_ID` | Same account id, read by the audio-rendition deploy |

**None of these existed as of 2026-08-17**, which is why both deploy workflows
are red on master and why `api.antiphony.dev` still answers from a pre-cutover
revision. `wrangler` fails before it validates any binding, so a missing token
looks nothing like a missing Hyperdrive id in the logs — check the token first.

## 4. Apply the database schema

```bash
psql "$DATABASE_URL" -f apps/core-api/db/schema.sql
```

Apply-once DDL, not a versioned chain. The first post-deploy schema change is
when that stops being fine and a migration tool becomes necessary.

## 5. Move the data

Two independent halves. **Object paths are unchanged across the move**
(`blobs/{originAppId}/{cid}`), so no record needs rewriting to point at the new
bucket — a property of content addressing, and the reason these can run in
either order or concurrently.

**Blobs — Cloudflare Super Slurper, no code.** R2 → Data Migration in the
dashboard copies GCS → R2 natively, given a service account with
`Storage Object Viewer` plus `storage.buckets.get`.

**Records — already done, because there is nothing to move.** A dry run against
`antiphony-core` on 2026-08-16 found `posts` and `audio_transcripts` both
**empty**: nothing has ever been written through `/api/v1/posts` in this
project, so the cutover is just pointing at Neon. What the store does hold is
the legacy Vox Pop model the extraction inherited (17 prompts, 33 replies, 13
users), which is not an `AudioPostRecord` and which the script correctly
ignores. Bringing that across would be a model translation rather than a store
swap — see § 2d in the migration spec.

To confirm it yourself:

```bash
FIREBASE_PROJECT_ID=antiphony-core \
  npm run migrate:firestore-to-neon -w @antiphony/core-api -- --dry-run --allow-empty
```

A dry run needs no `DATABASE_URL` — it touches no database, and passing one it
never uses is what an earlier version wrongly demanded. `--allow-empty` is
required to acknowledge an empty store: reading zero records from both
collections is far more often a credential or project mismatch than a genuinely
empty one, so the script refuses to report success without it.

If records ever DO need moving, dropping `--dry-run` writes them, and the script
**verifies itself** — every migrated post is read back and its CID recomputed,
exiting non-zero on any drift. That check is inline rather than a later audit
because the failure is silent: `jsonb` stores numbers as `numeric`, wider than
JS, so a coercion would change a record and invalidate every StrongRef pointing
at it while both sides continued to agree with themselves. Drift caught during
the run is one record to investigate; caught afterwards it is an unknown subset.

Re-running is safe — every write is an upsert keyed on the record's own id, so
a partial run resumes by running again. Nothing is deleted from Firestore.

## 5b. Deploy the transcode service (optional)

`apps/audio-rendition` derives `mp3` renditions for callers that cannot decode
webm/opus — Twilio's `<Play>` being the one that matters. It is a container
rather than a Worker because it spawns ffmpeg.

**Skippable.** Without it, `GET /api/v1/audio?format=mp3` serves renditions that
already exist and 404s the rest. That is the right state for a deployment that
pre-warms everything it needs, or that never phones anything.

`.github/workflows/deploy-audio-rendition.yml` ships it, and needs three
Secret Manager secrets granted to the runtime service account
(`system-auth-token`, `r2-access-key-id`, `r2-secret-access-key`) plus an
`R2_ACCOUNT_ID` repo variable. See
[`apps/audio-rendition/README.md`](../apps/audio-rendition/README.md).

The R2 key is the **one place in Antiphony a stored R2 credential is
unavoidable** — everywhere else access is a Worker binding. Scope it to the one
bucket: `blobs/` read, `renditions/` write.

Then point core-api at it by replacing the `REPLACE_ME` in
`ANTIPHONY_RENDITION_SERVICE_URL` in `apps/core-api/wrangler.jsonc` with the
deployed Cloud Run URL. That var and `SYSTEM_AUTH_TOKEN` go together — a URL
with no token is a rendition path that looks configured and 401s on every miss,
which core-api logs once at startup rather than per request.

## 6. Deploy

Push to `master`, or run the workflow by hand. It proves every app-DID pin,
asserts the Worker bundle carries no Node-only dependency, deploys, and smoke
tests `/health`.

To deploy from a laptop:

```bash
npm run deploy -w @antiphony/core-api
```

## 7. Point the domain at it

Add a route for `api.antiphony.dev/*` to the `antiphony-core-api` Worker
(Workers & Pages → the Worker → Settings → Domains & Routes). Because both
sides are Cloudflare, there is no origin behind the edge to reach around — which
is why the origin lock the Cloud Run deployment needed is gone rather than
ported.

Confirm the cutover with the one route that answers without a credential:

```bash
curl -s https://api.antiphony.dev/health
```

`backend` reports which store is actually wired (`postgres` or `firebase`),
which is the question that stops being answerable from the commit alone during
a migration.

---

## Rollback

**A bad deploy:** roll back to the previous version in the dashboard
(Workers & Pages → the Worker → Deployments), or `npx wrangler rollback`.
Instant and needs no rebuild.

**A bad data cutover — records:** this is the one that stopped being a config
flip. On Cloud Run, unsetting `DATABASE_URL` fell back to Firestore. On Workers
the bindings are mandatory — `composition.ts` throws rather than falling back —
because a Worker holds no Application Default Credentials and could not reach
Firestore if it tried.

That matters less than it sounds, because the fallback was never a meaningful
records rollback: `posts` and `audio_transcripts` are empty (§ 5), so falling
back to Firestore would mean falling back to nothing. **The real recovery for a
Neon problem is Neon's own** — point-in-time restore, or restoring onto a
branch — not a swap to a store that never held these records.

**A bad data cutover — blobs:** here the old copy is real. Super Slurper copies
rather than moves, so GCS keeps every object, and the paths are identical on
both sides (a property of content addressing). The bytes are safe regardless;
what is Worker-only is the access path, so reaching them again means a runtime
with a GCS binding rather than a config change.

## Operational notes

**The TTL sweep** runs hourly from the Worker's Cron Trigger and drives
`antiphony_sweep_expired()`. It is pure space reclamation — both upserts already
treat an expired row as absent — so it can run late, partially, or not at all
without anything observable changing except disk. Run it by hand if the tables
ever look large:

```sql
select * from antiphony_sweep_expired();
```

**Pin drift** is reported on the same hourly trigger. A tenant whose `did:web`
document stops naming us logs at `error` with the reason, and fails closed at
its next request. This is the ongoing-custody check the Cloud Run boot gate only
ever performed when a process happened to restart.

**Latency.** Neon is single-region on AWS `us-east-1` and Workers run near the
user, so Smart Placement is on from the first deploy — see § Geography in the
migration spec. The regression it prevents is invisible when testing from the US
east coast, which is the reason it is not something to enable after measuring.
