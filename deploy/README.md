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

```bash
# The database. Hyperdrive holds the Neon credential; the Worker only ever sees
# a LOCAL pooled connection string, which is why the database is not a secret.
npx wrangler hyperdrive create antiphony-neon \
  --connection-string "postgres://…@…us-east-1.aws.neon.tech/antiphony?sslmode=require"

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

The R2 bucket (`antiphony-r2-bucket`) is created in the dashboard, or with
`npx wrangler r2 bucket create antiphony-r2-bucket`.

## 2. Secrets

Three, and none of them appears in any committed file. Cloudflare secrets are
write-only from outside — nothing reads one back — which is exactly why the
schema apply and the data migration in step 5 cannot use them.

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

**Records — the migration script.** Run by an operator with `DATABASE_URL` and
`GOOGLE_APPLICATION_CREDENTIALS` in the environment:

```bash
npm run migrate:firestore-to-neon -w @antiphony/core-api -- --dry-run
```

Worth running early regardless of when the cutover happens: `--dry-run` reads
and validates every Firestore record against the current schemas and reports
pre-existing bad rows without writing anything.

Drop `--dry-run` to write. It **verifies itself** — every migrated post is read
back and its CID recomputed, and it exits non-zero on any drift. That check is
inline rather than a later audit because the failure is silent: `jsonb` stores
numbers as `numeric`, wider than JS, so a coercion would change a record and
invalidate every StrongRef pointing at it while both sides continued to agree
with themselves. Drift caught during the run is one record to investigate;
caught afterwards it is an unknown subset.

Re-running is safe — every write is an upsert keyed on the record's own id, so
a partial run resumes by running again. Nothing is deleted from Firestore.

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

**A bad data cutover:** this is the one that is no longer a config flip. On
Cloud Run, unsetting `DATABASE_URL` fell back to Firestore. On Workers the
bindings are mandatory — `composition.ts` throws rather than falling back —
because a Worker holds no Application Default Credentials and could not reach
Firestore if it tried. So reverting the store means reverting the runtime.
Nothing is deleted from Firestore by the migration, so the data is still there;
recovering it means redeploying a Node build from before this cutover.

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
