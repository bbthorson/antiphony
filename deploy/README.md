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

Three, and `wrangler deploy` fails on a config naming any that does not exist —
which is the point: a missing binding is caught before a deploy rather than at
the first request that needs it.

> ✅ **Done on 2026-08-17** for account `dd03fe171a20e2a1728b90c2f16ae4f4`. The
> ids below are committed, so this section is a record rather than a step —
> re-run it only for a fresh account.

> **There is no Hyperdrive config, deliberately.** The driver conflict is
> resolved as **option A**: `core-api`'s SQL client is `@neondatabase/serverless`
> in HTTP mode, which derives an HTTPS endpoint from the connection string's
> hostname, and a Hyperdrive string points into Cloudflare's network rather than
> at Neon. Since `readRuntimeEnv` PREFERS Hyperdrive when bound, creating one
> would break the database outright. The `hyperdrive` block is gone from
> `apps/core-api/wrangler.jsonc` and the database is a Worker secret instead
> (§ 2). Neon's pooled (`-pooler`) host is correct for that. Getting Hyperdrive
> later is option B — a driver replacement, not a binding. See § Verified deploy
> blockers in [`specs/cloudflare-migration.md`](../specs/cloudflare-migration.md).

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
not credentials. Only `PIN_CACHE` has an id in the config; queues are bound by
name, which is why the queue ids are recorded here and nowhere else:

| Resource | Id |
| :--- | :--- |
| `PIN_CACHE` KV namespace | `7bdd861a89e7499d9a52366e8fa5d393` |
| `antiphony-processing` | `83b13d87b09b4ded940cae4a914f173a` |
| `antiphony-processing-dlq` | `d3da1758e098419490fec45ea12da07b` |

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

Four, and none of them appears in any committed file. Cloudflare secrets are
write-only from outside — nothing reads one back — which is exactly why the
schema apply in step 4 and the blob migration in step 5 cannot use them: those
run in a shell, against Neon and GCS, with no Worker involved.

```bash
cd apps/core-api
npx wrangler secret put SYSTEM_AUTH_TOKEN
npx wrangler secret put ANTIPHONY_APP_TOKENS
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put DATABASE_URL
```

`DATABASE_URL` is the fourth because option A won the driver decision (§ 1) —
Neon's **pooled** (`-pooler`) connection string, the one real database
credential this Worker holds. Under Hyperdrive it would not exist here at all,
which is the trade that decision made: a secret to hold, in exchange for a
driver that works today.

**Not** R2 (binding-based authorisation needs no credential).
`ANTIPHONY_APP_DIDS` is deliberately a `var` rather than a secret: DIDs are
public, and keeping it in the config is what lets the deploy gate prove the pins
without access to anything secret.

Each `secret put` prompts for the value on stdin, so these are four
interactive commands — nothing to paste into a file, and nothing that survives
in shell history.

## 3. GitHub

| Kind | Name | Value |
| :--- | :--- | :--- |
| Secret | `CLOUDFLARE_API_TOKEN` | API token — permissions below, and **`Workers Scripts:Edit` alone is not enough** |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Account id — an identifier, not a credential |
| Variable | `R2_ACCOUNT_ID` | Same account id, read by the audio-rendition deploy |

### The token's permissions

`wrangler deploy` validates **every binding in the config against the API**
before it uploads anything, so the token needs read access to each resource the
config names — not just the right to write a script. An earlier version of this
file said `Workers Scripts:Edit`, and a deploy with exactly that failed:

    A request to the Cloudflare API (/accounts/…/r2/buckets/antiphony-r2-bucket) failed.
      Authentication error [code: 10000]

Account permissions the current config requires:

| Permission | Why |
| :--- | :--- |
| `Workers Scripts:Edit` | Upload the script |
| `Workers R2 Storage:Edit` | The `BLOBS` binding — this is the one that failed above |
| `Workers KV Storage:Edit` | The `PIN_CACHE` binding |
| `Queues:Edit` | The producer and consumer bindings |
| `Account Settings:Read` | Account lookup during deploy |

Plus `User → Memberships:Read` and `User → User Details:Read`, whose absence
prints warnings rather than failing, and `Zone → Workers Routes:Edit` **only if
routes move into this config** — the route attached in step 7 was added through
the dashboard, which needs nothing from this token.

Validation **stops at the first binding that fails**, so a too-narrow token
reveals its gaps one red build at a time. Grant the whole set at once. The token
in use is broader still (AI, Containers, D1, Hyperdrive, Cloudchamber, Vectorize,
SSL) — that is a build token reused across projects, not what this deploy needs;
narrowing it to the table above would cost nothing here.

**All three exist as of 2026-08-17.** The `Kind` column is the whole content of
this section: `secrets.FOO` and `vars.FOO` are separate namespaces in Actions, so
an account id added under Secrets leaves `vars.CLOUDFLARE_ACCOUNT_ID` resolving
to an empty string while the settings page looks complete. That is how these were
first added, and it reproduces the original blocker exactly. The ids belong under
Variables *because* they are not credentials: an unmasked empty value is visible
in a log, where `***` is not.

`wrangler` fails before it validates any binding, so a missing token looks
nothing like a bad binding id in the logs — check the token first.

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

> ⚠️ **Skipping it is not the same as leaving the placeholder in.** As shipped,
> `ANTIPHONY_RENDITION_SERVICE_URL` still reads
> `https://antiphony-audio-rendition-REPLACE_ME.us-east4.run.app`, and
> `renditionServiceConfig()` only checks that the var is NON-EMPTY. A placeholder
> therefore counts as configured — which is precisely the state that function's
> own comment exists to prevent. Every mp3 miss then fetches a host that does not
> resolve, waits, logs `[rendition] service unreachable`, and 404s anyway. To
> genuinely skip the service, DELETE the var; to use it, set the real URL below.

`.github/workflows/deploy-audio-rendition.yml` ships it, and needs three
Secret Manager secrets granted to the runtime service account
(`system-auth-token`, `r2-access-key-id`, `r2-secret-access-key`) plus an
`R2_ACCOUNT_ID` repo variable. As of 2026-08-17 only `system-auth-token` exists;
the two R2 keys have never been created. See
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

The smoke test asserts the **SHA**, not `"ok":true`. `ok:true` is true of any
healthy deployment at that hostname — so it passed while `api.antiphony.dev`
still answered from Cloud Run, and would pass on any stale version. It matches
`/health`'s `sha` against `GITHUB_SHA` instead, which cannot be satisfied by
something this workflow did not produce. Its one remaining blind spot: a
`workflow_dispatch` re-run of the SAME commit is satisfied by the previous
deploy of that commit, since only `BUILD_TIME` differs.

That step is also the migration's most-repeated lesson: when `Deploy` fails,
GitHub **skips** it, so the one step whose job is to say "live is not what you
merged" is exactly the step that does not run. It stayed silent for 17 hours
that way. A red `Deploy` is the thing to read; a green run with a skipped smoke
test is not a deploy.

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

> ✅ **Attached 2026-08-17T22:05Z. The cutover is done.** `api.antiphony.dev`
> answers from the Worker on `backend: postgres`. Until the route existed the
> Worker was reachable only at `antiphony-core-api.bbthorson.workers.dev`, and
> the domain still served the Cloud Run revision `4f07b24` on `firebase` — the
> two hostnames disagreeing is what a half-finished cutover looks like from
> outside, and `/health` is what makes it visible.
>
> Rolling the cutover back is removing this route: the Cloud Run revision is
> still running and untouched, so it resumes serving. That is a dashboard action,
> not a redeploy.

Confirm the cutover with the one route that answers without a credential:

```bash
curl -s https://api.antiphony.dev/health
```

`backend` reports which store is actually wired (`postgres` or `firebase`),
which is the question that stops being answerable from the commit alone during
a migration.

**`workers.dev` is on**, because the config sets no `workers_dev` key and the
default is enabled — the deploy log warns about it, and preview URLs come with
it. It is how the Worker was verified before the route existed. It also means a
second public hostname reaching the same Worker, which is a real qualification
of "no origin to reach around" above: every route but `/health` still needs a
token, so it is not a hole, but anything configured at the edge for
`api.antiphony.dev` does not apply there. Setting `"workers_dev": false` is the
deliberate version of this decision, either way.

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
