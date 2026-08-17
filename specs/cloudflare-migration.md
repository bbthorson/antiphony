# Cloudflare migration — investigation

Moving `apps/core-api` from Cloud Run + Firestore + Firebase Storage + Cloud Tasks
to **Cloudflare Workers + Neon + R2 + Queues**, with `jose` replacing the Firebase
Auth pieces.

This is an assessment, not a plan of record. It says what ports cleanly, what does
not, and what the two genuine blockers are. Nothing here is committed to.

## Status — read this first

**Last updated 2026-08-17.** This document is long because it is the reasoning
record. This section is the operational state.

> ### 🔴 LIVE on the Worker since 2026-08-17 22:05 UTC — one half still outstanding
>
> `api.antiphony.dev` resolves to the Cloudflare Worker. `/health` reports
> `backend: postgres`.
>
> | | State |
> |---|---|
> | Records (posts, transcripts) | ✅ migrated — 14 + 11, `cidDrift: 0` |
> | **Blobs (audio bytes)** | ❌ **NOT migrated — R2 is empty, every blob 404s** |
>
> **So audio is unavailable platform-wide until Super Slurper runs** (§ Step 2d).
> Records resolve, post views carry embeds, and those embed URLs 404 when fetched —
> which downstream apps see as "the audio failed", not as an outage.
>
> The DNS cutover preceded both data migrations, which cost a ~20-minute total
> blackout. Read § Step 2d's precondition before repeating any part of this, and
> § Execution record for what it looked like from outside (short version:
> `/health` stayed green throughout).
>
> Firestore and GCS are untouched. Rollback is repointing the domain at Cloud Run.

### Landed on master

| PR | What |
| :--- | :--- |
| #81 | This investigation |
| #83 | Six dead `/system/*` routes + the user-identity layer deleted; Firebase Auth gone |
| #86 | Storage ports (`RateLimitStore`, `IdempotencyStore`, `SqlClient`) + all four Postgres bindings, tested against real PG18 via PGlite |
| #87 | R2 blob store; audio proxy streams instead of 302-ing (contract `0.5.0`) |

| #89 | Step 3a — the composition root, and the Firestore→Neon cutover switch |

### In flight

**Step 3 (b–e) — the Worker.** Four commits on
`claude/cloudflare-migration-steps`:

| Commit | What |
| :--- | :--- |
| 3b | Workers entry + per-app `wrangler.jsonc`, Smart Placement on, cron wired |
| 3c | Queues replacing Cloud Tasks; `PROCESSING_LEASE_MS` re-derived |
| 3d | Boot gate replaced by four mechanisms; origin lock deleted; **Cloud Run retired** |
| 3e | `rate_limits` → Durable Object |

Three things came out differently from how this section scoped them, all
recorded in the commits:

- **3b was not "an entry file replacing `serve()`."** `app.ts` and every route
  handler are shared by both runtimes and a Worker bundle has no `external`
  escape hatch, so the whole transitive import graph had to be able to run on
  Workers. It could not: a first dry-run bundle came to 7MB and contained
  `firebase-admin`, `google-auth-library`, `protobufjs` and `grpc`. Three
  install seams now take the native half (`src/native.ts`), and
  `check:worker-bundle` fails CI if any of it comes back.

  Two of those imports were a **bug**, not a design: `middleware/rate-limit.ts`
  and `lib/idempotency.ts` both defaulted their store argument to the Firestore
  binding and no caller ever passed another, so the Postgres bindings from #86
  were unreachable in production by any configuration.

- **The lease had no margin on Cloud Run either.** `--timeout 900` already
  equalled `PROCESSING_LEASE_MS`, and Cloud Tasks derived its deadline *from*
  the lease, so all three numbers were one number. Queues did not introduce the
  problem; it removed the last place to adjust it. Fixed by inverting the
  derivation: `PROCESSING_EXECUTION_CEILING_MS` (15 min) names the fact, the
  lease is derived to sit strictly above it (20 min), and dispatchers bound
  themselves by the ceiling.

- **3d took Cloud Run with it.** Deleting the origin lock and deleting
  `src/index.ts` both presume the runtime has moved, and doing one without the
  other leaves the tree incoherent. Decided 2026-08-16 to land both: the
  Dockerfile, `deploy/cloudrun.env.yaml` and the no-traffic → smoke-test →
  promote sequence are gone, and `deploy.yml` deploys the Worker.

### Remaining engineering

- **Step 4 — ffmpeg consolidation.** In progress on
  `claude/step4-rendition-format`. See § The ffmpeg problem and
  [`mp3-rendition-stage.md`](./mp3-rendition-stage.md).

  | | What | State |
  | :--- | :--- | :--- |
  | 4a | `?format=` on the audio proxy, over `renditions/{app}/{cid}.{format}` | ✅ done (contract `0.5.1`) |
  | 4b | `apps/audio-rendition` adopted into Antiphony, taking `{originAppId, cid, format}` | ✅ done |
  | 4c | Wire transcode-on-miss: the proxy calls the service when a rendition is absent | ✅ done |
  | 4d | Move `trim` / `waveform` onto the service, restoring both stages on Workers | ✅ done |
  | 4e | Vox Pop repoints **telephony** at `?format=mp3` | ✅ code landed, **flag OFF** (vox-pop `d1fad798`) |
  | 4e′ | Vox Pop repoints **creator-download** | ✅ decided (option 1) — ready to implement, see below |
  | 4f | Retire Vox Pop's copy of the service | after 4e + 4e′ cut over |

  4e went in behind `ANTIPHONY_RENDITIONS`, unset. Because Vox Pop's Cloud Run
  vars live on the service rather than in its deploy workflow, the cutover is one
  `gcloud run services update` with a one-command undo and no deploy.

  It turned out to be a **query-parameter append, not a translation**: the
  routing contract hands telephony `AudioEmbedView.url`, which since `0.5.0` is
  the audio proxy, so an mp3 is `&format=mp3` on a URL it already has. The
  adapter validates the host and path before appending, because `format` means
  nothing to `storage.googleapis.com` — an older record's signed URL would take
  the parameter and serve webm/opus, which Twilio plays as static while reporting
  success.

  **Do not set the flag yet.** Verified 2026-08-17: `api.antiphony.dev/health`
  reports sha `4f07b24` and `backend: firebase` — an older Cloud Run revision
  with no `format` support at all. The Worker is not deployed, the transcode
  service is not deployed, and open question 1 below is unresolved.

### ✅ Download filenames — decided 2026-08-17: the BFF streams the bytes

Repointing the creator-download route would **silently regress downloads to
CID-named files**, and `apps/web`'s own comment is why:

> `download` on the anchor is ignored cross-origin, which is fine: the rendition
> sets `Content-Disposition` and wins.

The route hands the browser a URL. The old transcode service set that header from
a `filename` query parameter. Antiphony's audio route sets no such header — the
service was adopted **without** `buildContentDisposition`, deliberately, because
it now writes to R2 and serves no browser at all.

So this is not a break (it degrades to the `original` fallback's existing
behaviour) but it is a regression of the feature that route exists for, and it
needs a decision rather than a default:

1. **The BFF streams the bytes** and sets `Content-Disposition` itself. Correct
   side of the seam — the filename is composed from a prompt title and a replier
   handle, both Vox Pop's data — and it is what
   [`mp3-rendition-stage.md`](./mp3-rendition-stage.md) § Open questions (4)
   guessed. Cost: the route's contract changes from returning a URL to returning
   bytes, which `apps/web` consumes.
2. **Antiphony's audio route takes `filename`.** Cheapest, and wrong: it
   re-imports a header-injection boundary into a public anonymous route that this
   migration deliberately removed it from.
3. **Leave the download on the old service indefinitely.** Then `apps/audio-rendition`
   never retires, and Vox Pop keeps a Google Cloud dependency its own migration
   spec § 13 wants gone.

**Option 1 is chosen.** Vox Pop's BFF fetches from Antiphony and sets
`Content-Disposition` itself; the filename stays composed from prompt title +
replier handle, which is Vox Pop's data and belongs on Vox Pop's side of the
seam. This is also what
[`mp3-rendition-stage.md`](./mp3-rendition-stage.md) § Open questions (4)
guessed, so the two specs now agree.

The costs are accepted rather than overlooked:

- `GET /replies/{id}/download` changes from returning `{url, filename, format}`
  to returning **bytes**, so `apps/web`'s `ReplyDetailPanel` changes with it —
  its anchor-and-`download` dance goes away, because the header does that job
  once the response is same-origin.
- Download traffic flows **through** the BFF rather than being a redirect. Fine
  on volume: a creator fetching their own reply is not a hot path.

What that unblocks, and in what order: 4e′ can be implemented now, but 4f still
waits for **both** 4e and 4e′ to have actually cut over, because until then the
old service is still serving one of the two consumers.

Note this is the one place the adoption's "mostly deletion" gets a bill.
Dropping `buildContentDisposition` was right for the service — it writes to R2
and serves no browser — but the header it produced was load-bearing for a
consumer nobody was looking at, and that only surfaced when 4e went to repoint
the second caller. Worth remembering as a pattern: deleting a defence is safe
when the thing it defended is gone; deleting a *feature* needs its consumers
enumerated first.

  **Its pace is still not entirely ours from 4e on** — the service sits on a live
  Twilio path, so a change to it is a change to real calls. But the specific
  blocker this section used to name has cleared; see below. 4a–4d are Antiphony's
  alone and touch no live caller.

  ⚠️ **4e has a consequence worth deciding before it starts.** The adopted
  service does not carry `buildContentDisposition` across: it writes to R2 and
  returns a path, so it serves no browser and has no header to set. Vox Pop's
  creator-download route currently gets `Content-Disposition: attachment;
  filename=…` from the old service, so when it repoints it has to set that
  header itself. That is the right side of the seam — the filename is composed
  from a prompt title and a replier handle, both Vox Pop's data — and it matches
  what [`mp3-rendition-stage.md`](./mp3-rendition-stage.md) § Open questions (4)
  guessed. It is still a change nobody has written down as Vox Pop's to make.

  ✅ **The `trim` / `waveform` gap is closed.** Both resolved unavailable on
  Workers between 3b and 4d — the truthful state, but a capability the Cloud Run
  deployment had and its replacement did not. They now go over HTTP to the
  service, so their availability is "is a transcode backend configured" rather
  than "is a binary present", which is the only answerable form of the question
  on a runtime that cannot hold the binary.

  ✅ **The sequencing caution below is satisfied.** § The ffmpeg problem says to
  let Vox Pop's extraction soak and land its step 5 first, citing `aa6759e5` as
  mid-cutover. Vox Pop `c48c4dee` (#887, 2026-08-16) retired `functions/`
  entirely — source tree and deployed function — which is that step 5. The
  stacked-reversal hazard is gone.

### ⚠️ 2d has nothing to migrate — verified 2026-08-16

A dry run against `antiphony-core` found the canonical collections **empty**:

| Collection | Docs |
| :--- | ---: |
| `posts` | **0** |
| `audio_transcripts` | **0** |
| `prompts` | 17 |
| `replies` | 33 |
| `users` | 13 |

Nothing has ever been written through `/api/v1/posts` in this project. The
records migration is a no-op and the cutover is just pointing at Neon.

**What IS there is the legacy Vox Pop model** the extraction inherited. A
`prompts` document carries `audioUrl, authorId, createdAt, description,
replyCount, status, title` — no `cid`, no `originAppId`, no `kind`, no `embed`,
no `reply`. It is not an `AudioPostRecord`, and
`migrate-firestore-to-neon.ts` correctly does not touch it.

**Open decision, and it is a product one:** do those 17 prompts and 33 replies
come across? That is a **model translation**, not a store swap — computing CIDs
for records that never had one, assigning `originAppId`, deriving `kind`,
rebuilding `reply.root` / `reply.parent` StrongRefs from the legacy parent
links, and turning `audioUrl` into a content-addressed blob ref. Materially more
work than 2d was, and out of scope for this migration unless someone decides
otherwise. If the answer is "that is Vox Pop's data and it stays there", **step 2
is done**.

Note also that `users` / `handles` / `atproto_oauth_states` still hold rows but
have had no reader since #83 deleted the identity layer. They are legacy too.

### ⛔ Verified deploy blockers — 2026-08-17

Step 4 is merged (#94, `f03936f`). **Nothing is deployed**, and the reasons are
now known from logs rather than guessed. `api.antiphony.dev` answers from
`4f07b24` with `backend: firebase` — ten commits behind master, i.e. the last
revision before the Workers cutover.

| # | Blocker | Evidence |
| :--- | :--- | :--- |
| 1 | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` do not exist | `Deploy core-api` fails at `wrangler deploy`: *"In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN"*. The log shows `CLOUDFLARE_ACCOUNT_ID:` empty |
| 2 | `github-deploy@` cannot act as the Cloud Run runtime SA | `Deploy audio-rendition` fails at `gcloud run deploy`: *"Permission 'iam.serviceaccounts.actAs' denied on service account 636106936349-compute@…"*. Needs `roles/iam.serviceAccountUser` |
| 3 | `R2_ACCOUNT_ID` repo variable does not exist | Same log: `R2_ACCOUNT_ID=` empty |
| 4 | **The HTTP driver and Hyperdrive do not compose** | See below — this one is a code defect, not missing config |
| 5 | Hyperdrive / KV / queue ids are `REPLACE_ME` placeholders | Never reached; blocker 1 fails first |

**`deploy.yml` failing has been silent for ~17 hours.** Its run for #92
(`d89f31d`) failed the same way at 2026-08-16T22:04, and because `Deploy` failed
the `Smoke test` step was *skipped* — so the one step whose job is to say "what
is live is not what you merged" never ran. Worth fixing independently of the
credentials: a deploy job that fails silently is worse than one that fails.

Both workflows carry `workflow_dispatch`, so master can be deployed without a new
commit once the above exist.

#### Blocker 4 in detail — the driver conflict

`adapters/outbound/postgres/client.ts` uses `neon()` from
`@neondatabase/serverless` in **HTTP mode**. That driver derives an HTTPS
endpoint from the connection string's hostname and POSTs to `https://{host}/sql`.
A Hyperdrive connection string points into Cloudflare's network, not at Neon, so
the POST goes nowhere. And `readRuntimeEnv` *prefers* Hyperdrive when bound:

    const databaseUrl = hyperdrive?.connectionString ?? DATABASE_URL ?? …

So **binding Hyperdrive with the current driver breaks the database entirely.**

This spec contains both halves of the conflict and they were never reconciled:
§ Driver says "**Hyperdrive + `postgres.js`** over raw TCP is the better
default", and § Answered says "start on `@neondatabase/serverless` (HTTP) …
**Hyperdrive at step 3 is now expected rather than optional**". The
`wrangler.jsonc` written in 3b took the Hyperdrive half without the driver half.

Two ways out:

- **A — ship without Hyperdrive.** Remove the `hyperdrive` block and set
  `DATABASE_URL` as a Worker secret pointing at Neon's own host (the pooled
  `-pooler` endpoint is fine; the HTTP driver is stateless). Works unchanged on
  Workers, since the driver is just `fetch`. Keeps Smart Placement; loses
  Hyperdrive's warm connections. **Recommended first**, because it is a config
  change and unblocks everything else.
- **B — keep Hyperdrive, replace the driver.** Swap `neonSqlClient` for
  `postgres.js` or `pg` behind the unchanged `SqlClient` port, and create the
  Hyperdrive config against the **direct, non-pooled** Neon host — Hyperdrive
  pools itself, and stacking it on PgBouncer is discouraged. This is what
  § Driver actually recommended, and it is a piece of work rather than a config
  change.

Note the ports make this a late-binding choice exactly as intended: `SqlClient`
is one method, and every binding behind it is untouched either way.

### Remaining operational — this is now the critical path

Nothing is blocked on code, and **the Worker cannot deploy until 1–3 are done**:
`wrangler.jsonc` carries `REPLACE_ME_…` placeholders that fail the deploy rather
than starting up without a database. [`deploy/README.md`](../deploy/README.md)
is the runbook.

1. **Create the bindings.** Hyperdrive (from the Neon connection string), the
   `PIN_CACHE` KV namespace, and both queues (`antiphony-processing` and its
   dead-letter queue). Put the ids in `apps/core-api/wrangler.jsonc`.
2. **Set the three Worker secrets** — `SYSTEM_AUTH_TOKEN`,
   `ANTIPHONY_APP_TOKENS`, `ELEVENLABS_API_KEY`. Not the database (Hyperdrive
   holds it), not R2 (the binding needs no credential).
3. **Add the GitHub credentials** — `CLOUDFLARE_API_TOKEN` (secret, Workers
   Scripts:Edit) and `CLOUDFLARE_ACCOUNT_ID` (variable).
4. **Apply the schema.** `psql "$DATABASE_URL" -f apps/core-api/db/schema.sql`
5. **Super Slurper** for blobs — GCS → R2, dashboard, needs a service account
   with `Storage Object Viewer` + `storage.buckets.get`.
6. ~~**Run the records migration.**~~ **Nothing to migrate** — verified above.
   Re-run with `--allow-empty` if a confirmation is wanted; a dry run needs
   `FIREBASE_PROJECT_ID=antiphony-core` and no `DATABASE_URL`.
7. **Point `api.antiphony.dev` at the Worker** and confirm on `/health`, which
   reports which store is actually wired.

### What rollback actually looks like now

Two things changed at once here, and they pull in opposite directions, so it is
worth stating the combined position rather than either half.

**A bad deploy is the easy case, and it got easier.** `wrangler rollback`, or
the Deployments list in the dashboard. Instant, no rebuild — where the Cloud Run
equivalent was a revision promotion.

**A bad DATA cutover is the case that lost its escape hatch — and it turns out
there was nothing behind that hatch anyway.** On Cloud Run, unsetting
`DATABASE_URL` fell back to Firestore. Worker bindings are mandatory
(`composition.ts` throws rather than falling back), because a Worker holds no
Application Default Credentials and could not reach Firestore if it tried. So
the store swap stopped being a config flip.

But the fallback it replaced was never a meaningful records rollback: `posts`
and `audio_transcripts` are **empty**, so falling back to Firestore would have
meant falling back to nothing. The real recovery for a Neon problem is Neon's
own — point-in-time restore or a branch — not a swap to a store that never held
these records.

**Blobs are the half where the old copy is real.** Super Slurper copies rather
than moves, so GCS keeps every object, and the paths are identical on both sides
(`blobs/{originAppId}/{cid}` — a property of content addressing). The bytes are
therefore safe regardless. What is Worker-only is the access path, so reaching
them again means a runtime with a GCS binding, not a config change.

### Open questions

1. **Rendition rate-limit key.** `GET /api/v1/audio` is IP-keyed at 60/min and
   Twilio fetches from a small IP pool, so every concurrent call would share a
   handful of buckets. Blocks the telephony cutover, not the migration.

   **4c sharpened this.** The same limit now governs a request that can start an
   ffmpeg run, not just a storage read. The total work is still bounded by the
   corpus rather than the request rate — a `(cid, format)` pair transcodes once
   ever, and the backend refuses any pair with no source blob — so this is a
   burst-shaping problem rather than an unbounded one. But it is the same limit,
   doing more, on the route Twilio is about to point at.
2. **`audio-rendition` region.** It is `us-east4`, next to both Neon (`us-east-1`)
   and wherever Smart Placement parks the Worker. Confirm that is deliberate.
3. **A migration tool.** `db/schema.sql` is apply-once DDL, not a versioned
   chain. The first post-deploy schema change is when that stops being fine.

### Two things most likely to bite

- **The edge makes database reads slower**, not faster — Workers run near the
  user, Neon is single-region `us-east-1`, and the Cloud Run deployment this
  replaced was already co-located with it. Smart Placement is on from the first
  deploy and Hyperdrive is bound, which is the mitigation; what remains is that
  **the regression is invisible when testing from the US east coast**, so
  measuring it needs a client that is not. Still worth measuring both before and
  after rather than assuming the mitigation worked.
- ~~**The TTL sweep has no scheduler.**~~ **Closed in 3b.** The Worker's cron
  fires hourly at `:17` and drives `antiphony_sweep_expired()`. It logs at
  `info` even when it deletes nothing, deliberately: a zero-row sweep is the
  evidence that the cron is wired, and a sweep that quietly stops is otherwise
  indistinguishable from one with nothing to do. Note the `rate_limits` half now
  reads zero under the reference deployment by design — those buckets live in a
  Durable Object (3e).

## Verdict

The architecture was built for this. `packages/core` has zero Firebase imports by
construction, every backend touch goes through a `*Dependencies` port, and
[`ports/processing-dispatch.ts`](../packages/core/ports/processing-dispatch.ts)
names Cloudflare Queues as the case it was shaped around. The service layer, all
route handlers, the Hono app factory, and every core test move unchanged.

What does not move is narrower than it looks, and it is **not** the database or the
blob store — those are adapter swaps the ports already anticipate. It is two things:

1. **The ffmpeg stages.** `trim` and `waveform` shell out to a native binary. Workers
   cannot. This is the least alarming of the three, because the answer already exists:
   Vox Pop's `apps/audio-rendition` Cloud Run service. Antiphony should own it, and it
   should grow the ingest stages alongside its existing delivery job.
2. ~~**Firebase Auth.**~~ **Resolved — not a blocker.** The routes holding every
   Firebase Auth call have no caller left; Vox Pop ported its own copies and retired
   the fallback. They get deleted, not migrated. See § Resolved.

Plus one structural change that is easy to miss: **the fail-closed boot gate cannot
exist on Workers** — there is no process to fail. It is replaceable, and the
replacement is net stronger than what runs today, but it is four mechanisms where
there was one. See § The boot gate.

## What ports without thinking

| Piece | Why it's free |
| :--- | :--- |
| `packages/core` (services, ports) | No Firebase, no Node built-ins in the service layer. Untouched. |
| `app.ts` + every route handler | Hono runs natively on Workers. Route wiring is identical. |
| `@hono/zod-openapi`, zod, OpenAPI gen | Pure JS. |
| ElevenLabs adapters (denoise, transcribe) | One `fetch` with a `FormData` body. Already portable — the spec's `external API` stage class. |
| Webhook notifier | `fetch`. |
| Service-token auth (`requireServiceToken` / `requireAuth`) | Opaque tokens from env, constant-time compared. No Firebase, no Node crypto. |
| CID computation (`multiformats`, `@ipld/dag-cbor`) | Pure JS. |
| TID minting, blob paths, error envelopes, client-IP extraction | Pure JS. |

`src/index.ts` is deleted: `serve()` and `installShutdownHandlers` both become
`export default { fetch, queue }`.

## Where the metadata lives — Neon, and why not D1

Audio bytes go to R2. Everything else — post records, transcripts, processing
state, the infra tables — needs a home, and D1 is a fair question given the rest
of the stack is moving to Cloudflare.

**Use Neon for the domain data.** The deciding argument is not capability; D1 would
handle this volume comfortably. It is **portability**, and it is specific to this
project.

[`packages/core/README.md`](../packages/core/README.md) states the constraint the
whole architecture is built around — "zero `firebase` / `firebase-admin` imports.
Service code is portable to any backend whose bindings implement the ports" — and
names the intended escape hatch: "A self-hoster who wants Postgres support
implements the `*Dependencies` ports against their stack." The docs site says the
same. Antiphony is open core, and its reference deployment is also its
self-hosting example. Making the canonical store D1 would make that reference
implementation runnable only on Cloudflare, which inverts the property the ports
exist to protect. Postgres is the portable choice, and it is the one the docs
already promise.

Secondary, but real: D1 is single-writer by construction (each database is backed
by one Durable Object) and caps at 10 GB on the paid plan. Both are fine for beta.
Neither is a comfortable ceiling for something whose stated purpose is multi-tenant
audio infrastructure.

**Where Cloudflare-native storage *is* the better answer:**

- **`rate_limits` → a Durable Object.** This is the one table where Postgres is
  actively the wrong tool. It is a high-frequency counter write sitting on the
  **read** path, so putting it behind a network hop is the worst available choice —
  and per-key strongly-consistent counters are precisely what Durable Objects are
  for. The draft schema keeps a Postgres table because rate limiting must keep
  working before the Worker exists, but it is marked provisional. Check first
  whether the route still has a caller at all.
- **`idempotency_keys` → stays in Postgres.** KV is tempting and wrong: it is
  eventually consistent, and idempotency needs read-your-writes or it does not
  work. Volume is low (write endpoints only), so the table is fine.
- **Renditions → no rows at all.** The path is derivable and existence is an R2
  HEAD. Nothing to store, nothing to fall out of sync.

The draft is in [`apps/core-api/db/schema.sql`](../apps/core-api/db/schema.sql).

### Notable improvements the schema buys

- **Generated columns.** The query facets (`author_id`, `kind`, `root_author_id`,
  `reply_parent_uri`, `cid`) are `generated always as (record ->> …) stored`. In
  Firestore these were ordinary fields that could silently drift from the record;
  here drift is impossible.
- **The kind/reply invariant becomes a constraint.** `AudioPostRecordSchema.refine`
  enforces "reply ⇒ has parent and root author; prompt ⇒ neither" in Zod. Postgres
  now enforces it too. Firestore could not express it.
- **Transcripts get a real uniqueness guarantee.** The port documents
  `saveTranscript` as last-write-wins by subject uri, but the read path concedes
  "last write wins if a post somehow has multiple transcripts" — a convention, not
  a constraint. A unique index makes the documented contract the actual one.
- **Partial indexes.** `reply_parent_uri` and `root_author_id` are null on every
  prompt, so those two indexes cover only rows that can match.
- **`processing` and `lease_until` move out of the record column**, so a stage
  settle patches one jsonb field instead of rewriting the record, and the lease
  claim is an indexed conditional `UPDATE` on a typed timestamp.
- **Chunking disappears.** `getTranscriptsBySubjectUris` drops its 30-item
  `FIRESTORE_IN_LIMIT` loop and `Promise.all` fan-out for `where subject_uri = any($1)`.

### Replacing Firestore's native TTL

`firestore.indexes.json` declares native TTL on `idempotency_keys.expiresAt` and
`rate_limits.expiresAt`; Postgres has no equivalent, so both tables would otherwise
grow forever — one row per distinct `(uid, idempotency-key)` and one per client IP.

`antiphony_sweep_expired()` ships **with** the schema, driven by a Worker Cron
Trigger from step 3. It is deliberately **not** `pg_cron`: Neon runs pg_cron jobs
only while the compute is awake, and its own guidance is to use it only where scale
to zero is disabled. A beta service is idle nearly always, and idle is exactly when
scale to zero should be on — pg_cron here would fire rarely and unpredictably, which
is the same silent failure relocated into the database.

No interim scheduler was built for the Cloud Run window, and that call held.
**The sweep is pure space reclamation**: both upserts already treat an expired row
as absent, so deleting one is behaviourally identical to leaving it. It can run
late, partially, or not at all without anything observable changing. At beta volume
the accrual between the schema landing and the Worker was trivial, and a Cloud
Scheduler job built to live three weeks would have carried more failure modes than
the problem did. Run it by hand any time it looks large.

✅ It has a caller now: the Worker's Cron Trigger, hourly at `:17`.

## Firestore → Neon

Seven collections, in two classes.

**Domain data** — `posts`, `audio_transcripts`, `users`, `handles`. These have real
queries and the four composite indexes in
[`firestore.indexes.json`](../firestore.indexes.json) map one-to-one onto Postgres
btree indexes.

**Infrastructure** — `rate_limits`, `idempotency_keys`, `atproto_oauth_states`. All
three are TTL'd key-value with a transaction around them, and all three bypass the
port layer today (see § The five stragglers).

### Transactions get simpler, not harder

There are four `runTransaction` call sites, and every one collapses to a single SQL
statement:

- **Processing lease claim** ([`audio-processing-dependencies.ts:99`](../apps/core-api/src/adapters/outbound/firebase/audio-processing-dependencies.ts:99))
  → `UPDATE posts SET lease_until = $1 WHERE id = $2 AND origin_app_id = $3 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`. The port's
  "**must be atomic**" requirement is satisfied by the statement itself rather than by
  a transaction the adapter has to get right. The fencing-token release becomes
  `... WHERE lease_until = $claimed`, which is exactly the semantics the port doc
  describes.
- **Idempotency check** → `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING`, with the
  expiry as a `WHERE` predicate. The three-branch transaction becomes one upsert.
- **Rate-limit bucket** → one upsert with a `CASE` on window expiry.
- **Handle swap** ([`users-dependencies.ts:70`](../apps/core-api/src/adapters/outbound/firebase/users-dependencies.ts:70))
  → the one that genuinely wants a transaction, and gets a real unique constraint on
  `handles.handle` instead of a read-then-check. `ConflictError` comes from the
  constraint violation rather than from a racy read.

This is a strict improvement in correctness surface, and it is worth doing **even if
the Cloudflare move never happens**.

### Record storage: `jsonb` + extracted columns

`AudioPostRecord` is a lexicon document whose **CID is computed over its canonical
form**. Normalizing it into columns and reassembling on read risks changing the
record and therefore its CID — a silent data-integrity failure. Store the record as
`jsonb` and add indexed columns for the six fields the queries touch:
`origin_app_id`, `author_id`, `kind`, `created_at`, `root_author_id`,
`reply_parent_uri`.

`jsonb` does not preserve key order, but DAG-CBOR canonicalizes key order anyway, so
CIDs are stable across the round-trip. Numeric coercion is the thing to actually
verify — `jsonb` numbers are `numeric`, which is wider than JS, so a round-trip test
asserting `cidForRecord(read) === record.cid` belongs in the adapter's suite.

`AudioPostRecordSchema.safeParse` stays exactly where it is on the read path, so the
"validation failed, skip the doc" behaviour carries over unchanged.

### Pagination

Cursor pagination currently uses `startAfter(docSnapshot)`, which costs an extra read
per page. In Postgres it is keyset pagination on `(created_at, id)`. Post ids are
TIDs — time-sortable by construction — so the tuple comparison is well-ordered and
the extra fetch disappears.

### ⚠️ Geography: the edge makes this slower, not faster

**Neon is on AWS `us-east-1` (N. Virginia); Postgres 18.** The Cloud Run
deployment this replaced was `us-east4` (Ashburn) — the same metro, so database
round trips were single-digit milliseconds. That is a property the migration can
easily lose without noticing, and losing it would not show up as an error.

Workers run close to the **user**, not close to the database. A request served from
London against a database in Virginia pays ~80 ms per round trip, multiplied by
however many sequential queries the handler makes. For a database-backed API with a
single-region store, "moving to the edge" is a latency **regression** from a
co-located origin — and this deployment is currently co-located about as well as it
can be.

This is counterintuitive enough to be worth stating plainly, because the mistake is
invisible in testing from the US east coast.

Two mitigations, and both are wanted:

- **Smart Placement.** Cloudflare relocates Worker execution close to the backend
  when a Worker makes several round trips to one origin. That is exactly this
  workload's shape. It should be on from the first deploy, not added after someone
  measures.
- **Hyperdrive.** This raises its priority relative to the earlier recommendation.
  The argument before was pooling; with the geography known, the connection-setup
  cost it removes is a full extra round trip to Virginia on every cold path.

**The workload splits cleanly, and the split is good news:**

| Path | Edge verdict |
| :--- | :--- |
| Audio bytes from R2 (streaming proxy, renditions) | **Genuinely better at the edge** — R2 is distributed, payloads are large, responses are `immutable` and cache well |
| Post/transcript queries against Neon | **Wants Smart Placement** — small payloads, multiple sequential round trips, single-region store |

So the streaming-proxy decision benefits from the move and the posts surface has to
be defended against it. Worth measuring both before and after rather than assuming.

### Driver

**Hyperdrive + `postgres.js`** over raw TCP is the better default: Neon is explicitly
supported, you get real connection pooling (Neon's per-connection cost is the thing
that bites serverless), and interactive transactions work if the handle swap wants
one. `@neondatabase/serverless` over HTTP is the simpler fallback, but its
transaction support is batch-only — fine given the collapse above, limiting if
anything later needs a genuine interactive transaction.

## Firebase Storage → R2

The `BlobStore` port is four methods. Three are trivial against an R2 binding:
`upload` → `put`, `download` → `get`, `extractObjectPath` → pattern match. The
content-addressed path scheme (`blobs/{originAppId}/{cid}`) needs no change at all.

**`getSignedUrl` is the one that does not map.** R2 bindings cannot mint presigned
URLs — presigning needs S3 API credentials and an SigV4 implementation
([aws4fetch](https://github.com/mhart/aws4fetch)), which means storing an R2 access
key as a Worker secret.

The better answer on Cloudflare is to **stop signing and start streaming**. Today
`GET /api/v1/audio` 302s to a signed GCS URL. On Workers it can return the bytes
directly through the R2 binding: no credentials to store, no expiry to tune, R2
egress is free, and `R2Bucket.get(key, { range })` gives real range-request support
for seeking — which the 302 gets only because GCS happens to provide it.

Two consequences worth deciding deliberately:

- **It is a public contract change.** The OpenAPI doc says 302; it would say 200 with
  `audio/*`. For `<audio src=…>` this is invisible. For anything asserting on the
  redirect it is not.
- **It fixes the CORS caveat.** The long note at the top of
  [`app.ts`](../apps/core-api/src/app.ts) explains that a browser `fetch()` of the
  proxy cannot work today because following the redirect needs CORS on the *bucket*.
  Streaming through the Worker removes that entirely — the response is same-origin
  from the browser's point of view.

Downstream, `signAudioUrl` on the post-view path stops minting signed URLs and just
returns the proxy URL. That takes a storage round-trip out of every post read and
makes view responses cacheable, which they currently are not.

## Cloud Tasks → Queues

The cheapest part of the migration, because
[`processing-dispatch.ts`](../packages/core/ports/processing-dispatch.ts) was written
for it. `dispatch()` becomes `env.PROCESSING_QUEUE.send(job)`; the consumer becomes a
`queue(batch, env)` handler calling the same `AudioProcessingService.process`. The
job payload is two strings, far under the 128 KB message cap.

Keep `POST /api/v1/system/process-audio` as a manual re-drive path — it costs nothing
and is the thing you want at 3am.

**✅ The lease was re-derived in 3c.** `DISPATCH_DEADLINE_S` was set *at*
`PROCESSING_LEASE_MS` (15 min) on the reasoning that a delivery must never outlive
its own lease — and a Queue consumer's ceiling is also 15 minutes, so the two were
exactly equal with no margin.

The equality was not a Queues problem. Cloud Run's `--timeout 900` already equalled
the lease and Cloud Tasks derived its deadline *from* the lease, so all three numbers
were one number; Queues only removed the last place to adjust it, its cap not being
ours to move.

So the derivation was inverted rather than nudged.
`PROCESSING_EXECUTION_CEILING_MS` (15 min) now names what it always was — a fact
about every runtime the pass executes in — and `PROCESSING_LEASE_MS` is derived to
sit **strictly above** it, at 20 minutes. Dispatchers bound their delivery by the
ceiling, never by the lease.

Widening the lease rather than adding a self-imposed handler deadline: the deadline
approach threads an `AbortController` through `AudioProcessingService` and every
stage — the one part of this codebase the migration has otherwise left untouched —
and makes correctness depend on our own timer firing and on `finally` running after
a hard kill. Widening makes the platform enforce the ordering, with no code in the
handler. The cost is that a killed pass holds its claim for the 5-minute margin; a
pass reaching a 15-minute ceiling at all is pathological (ffmpeg is capped at 120s),
so making that case wait is the right trade against permitting a double write in it.

A side benefit: the Cloud Tasks adapter's documented concern about
`SYSTEM_AUTH_TOKEN` being stored in the queue for each task's lifetime disappears —
Queues invoke the consumer by binding, with no headers stored anywhere.

## The ffmpeg problem

`trim` (silencedetect + re-encode to Opus/WebM) and `waveform` (decode to raw PCM)
both `execFile` a native binary. On Workers: no `child_process`, 128 MB per isolate,
10 MB compressed bundle ceiling. `ffmpeg.wasm` is well over the bundle limit before
you get to its thread requirements. It is not viable, and
[`specs/enrichment-pipeline.md`](./enrichment-pipeline.md) § Deployment portability
already predicted exactly this fork.

### The service already exists

Vox Pop has **`apps/audio-rendition`** — a Cloud Run service that shells out to
ffmpeg, transcodes Antiphony webm/opus blobs to mp3 for Twilio `<Play>` and creator
downloads, and caches by content address. It has already been ported off Firebase
(`onRequest` → Hono, `admin.storage()` → a `RenditionCache` port), and its README
records the same fork this section describes, decided the other way: **one small
Cloud Run service over Cloudflare Containers**, on the grounds that Containers are a
new runtime and deploy system for a job that had run once.

That decision stands, and this section's earlier ranking was written without
knowledge of it. **Do not move ffmpeg to Cloudflare Containers.** Consolidate onto
the service that exists.

The end state is one ffmpeg service owned by Antiphony, serving two distinct jobs
that happen to share a binary:

- **Delivery / rendition** (today's `audio-rendition`) — on-demand, anonymous,
  read-path, cached by content address, output format chosen by the requester.
- **Ingest enrichment** (`trim`, `waveform`) — once per post, queue-driven,
  system-authed, write-path, mutating the canonical bytes.

Antiphony is the right owner because both jobs are about Antiphony blobs, and because
the rendition service currently reaches into Antiphony's bucket from outside — which
is what forces its whole SSRF apparatus (see below).

### Absorbing rendition into the audio proxy

The natural home is **not** a second public service inside Antiphony. It is
`GET /api/v1/audio`, which is already the one anonymous route and already has the
shape: blob ref in, audio bytes out, content-addressed, cacheable. Rendition is what
that endpoint becomes once it takes a `format` parameter. This also resolves an auth
tension that would otherwise be imported — Twilio fetches `<Play>` URLs with no
bearer, while every other Antiphony data route is gated.

Combined with § Firebase Storage → R2's recommendation that the proxy stream bytes
rather than 302, adding `&format=mp3` that dispatches to the transcode backend on a
cache miss is an increment, not a new surface.

**The security model gets strictly simpler.** `audio-rendition` today accepts a
source *URL* from an anonymous caller, so it carries a host allowlist, an
env-pinned bucket, a CID-shape regex, and a documented cache-poisoning defence: the
cache key is read off the caller-supplied path, so host-only allowlisting would let
an attacker host `blobs/voxpop/<victim CID>` in their own public bucket and have
attacker audio served `immutable` to the victim's callers. Inside Antiphony the
caller passes a **CID plus tenant**, and the service resolves the object itself
through `blobObjectPath()`. No URL parsing, no host allowlist, no bucket pin, no
attacker-authored source. It also removes the coupling that service's README flags
as a known landmine — `ALLOWED_SOURCE_HOSTS` hardcoded to `storage.googleapis.com`
while Antiphony's blobs move to R2.

### Where renditions live — decided

**Antiphony owns the blob, canonical and derived.** It stores and serves the audio;
services built on top store metadata for their own application. So the rendition
cache is not a separate bucket in a separate project (as `audio-rendition` has it
today, source in `antiphony-core` and cache in `vox-pop-simple`) — derived renditions
are Antiphony's, alongside the originals.

**Renditions are addressed by derivation, not by content:**

    renditions/{originAppId}/{sourceCid}.{format}

This deliberately departs from the `blobs/{originAppId}/{cid}` scheme, and the reason
is worth stating because the codebase already does the opposite for a neighbouring
case. `writeDerivedBlob` content-addresses derived (denoised) audio because that CID
goes **into a record** — the processed blob is referenced by a `BlobRef`, so it must
be portable and self-describing. A rendition is referenced by nothing: no lexicon
record points at it, no `at://` uri contains it. Content-addressing it would buy
portability nobody consumes and cost a `(sourceCid, format) → derivedCid` lookup on
every read. A deterministic path is derivable in the Worker with zero database
round-trip, which on a cache hit is the whole request.

The poisoning defence that `audio-rendition` needs a bucket pin for disappears here:
the path is composed from a tenant-scoped source CID the service resolved itself, and
only Antiphony can write to it.

### Transcode on demand — superseded for `mp3`

> **[`mp3-rendition-stage.md`](./mp3-rendition-stage.md) is the decision of
> record for the `mp3` rendition**, and it chose an eager per-tenant opt-in
> stage. What follows describes the on-demand path, which still applies to any
> format with no opt-in stage behind it — the two compose: a pre-generated
> rendition is a cache hit, and everything else transcodes on first ask.

**No eager rendition stage in the processing pipeline.** Transcode when a requesting
service first asks, then cache. Renditions stay out of `PROCESSING_STAGES` entirely,
which keeps the stage machinery, `capabilitiesOf`, and the settle/webhook path
unchanged, and avoids generating formats nobody requests.

The read path becomes:

1. Worker resolves `renditions/{app}/{cid}.{fmt}` and attempts an R2 `get`.
2. **Hit** — stream it. `immutable`, since the bytes for a content address never
   change.
3. **Miss** — call the rendition service (system-authed) with
   `{ originAppId, cid, format }`. The service reads the source from R2, transcodes,
   writes the rendition to R2, and returns. The Worker then streams from R2.

Note step 3 has the service read and write storage directly rather than passing bytes
through the Worker in both directions — the transcoded bytes never transit the Worker
twice, which matters against a 128 MB isolate. It also means the rendition service
needs R2 credentials, which is the `RenditionCache` port swap its README already
anticipates ("one line to swap for R2, at which point this service has no Google SDK
in it at all").

**One operational hazard, worth catching before it is a 3am call.** Twilio fetching
`<Play>` from Antiphony puts anonymous, bursty traffic on `GET /api/v1/audio`, which
carries `RATE_LIMITS.read` — 60/min, IP-keyed. Twilio's fetches arrive from a small
pool of Twilio IPs, so every concurrent call in the system shares a handful of
buckets and a busy period throttles live calls. This is the same failure mode
`system-auth-mint.ts` documents for IP-keyed limits on a system-to-system path
("every caller shares that server's IP, so an IP-keyed limit would collapse ALL
logins into one bucket"). The rendition path needs either an exemption or a
non-IP key before it carries telephony traffic.

### Requester-chosen output format

Three constraints, all load-bearing:

1. **Closed enum → fixed argument vector.** `FFMPEG_ARGS` is a constant today. A
   requester-influenced arg list built by string concatenation is arbitrary file
   write and worse. Map `mp3 | wav | m4a | …` onto hardcoded vectors and reject
   anything else — the format name must never reach ffmpeg as data.
2. **Cache key becomes `(cid, format)`.** It is the CID alone today and served
   `immutable`, so a format-blind key serves mp3 bytes to a wav request permanently.
3. **Canonical and derived stay strictly separate.** `ffmpegTrimmer` emits Opus/WebM
   as the *canonical* bytes for reasons documented in that adapter. Format selection
   is **read-path only**. Letting a tenant choose the canonical format would break the
   content-address dedup the entire blob scheme rests on — identical audio uploaded
   twice would land on different CIDs.

### Sequencing caution

As of `aa6759e5`, Vox Pop is **mid-cutover** on the extraction of this service: the
Worker has been repointed (step 3 of the README's five-step sequence), but step 5 —
deleting `functions/` — is deliberately still pending, because repointing the env
vars back is the rollback. Starting an Antiphony migration on top of an unsoaked
extraction stacks two reversals on each other. Let it soak and land step 5 first.

Related: that README's justification for Cloud Run over Containers rests partly on
"a job that has run **once**." Absorbing the ingest stages makes that false — it
becomes per-post work across every tenant. The conclusion does not change, but the
Cloud Run sizing and the `--max-instances` flag do need revisiting rather than
inheriting, since that flag is now load-bearing as an abuse cap.

The one genuine future argument for Containers is **data locality** — a container
adjacent to R2 versus Cloud Run pulling across clouds. R2 egress is free, so this is
a latency question rather than a cost one, and it is not a now decision.

### Not an option

**Dropping the stages.** `trim` is not cosmetic: it undoes ElevenLabs returning
320 kbps CBR MP3 for everything, which is a permanent ~2.5x storage inflation on
every denoised post.

Throughout, `TrimmerPort` and `WaveformPort` are unchanged — the adapters become a
`fetch` at the rendition service instead of an `execFile`. `capabilitiesOf(providers)`
and the stage-settling machinery never learn about any of this. It is a
deployment-topology decision, not an architecture one.

✅ **Landed in 4d, and the prediction held exactly.** Both ports are untouched;
`adapters/outbound/rendition/stages.ts` is the `fetch`. One thing the prediction
did not cover: it also removed an install seam. While those adapters reached
`node:child_process` they had to be injected by the Node entry point to keep
`ffmpeg-static` out of the Worker bundle — a `fetch` is portable, so the provider
registry declares them like every other entry, and `ffmpeg-static` left core-api's
dependencies entirely.

**Memory, separately.** `readBlobBytes` materializes the whole blob, and the port doc
flags this as portability hazard #1 against a 100 MB lexicon cap. In practice the
upload route caps at 25 MB, so a 128 MB isolate survives it — but only just, and only
because the container does the actual decoding. Streaming the port is still the right
long-term shape; it is not a blocker today.

## ✅ Resolved: the `/system/*` routes are dead

**Confirmed against the Vox Pop repo 2026-08-16.** All five are safe to delete.

`vox-pop/specs/archive/stream4-f7-execution.md` records the port, all boxes checked:

- **A1 (merged #722)** — `/api/v1/system/atproto-state/:key` and
  `/api/v1/system/atproto-session/:key` ported to the BFF.
- **A2** — `/api/v1/system/users/:uid/bluesky-identity` and
  `/api/v1/system/atproto/signin` ported; `apps/web` repointed.
- **G1** — `system-auth-mint.ts` ported verbatim and mounted on the BFF at
  `/api/v1/system/auth`; `session-management.ts` repointed.

G1's note mentioned a `CORE_API_BASE_URL` fallback, which would have kept a live
path back to Antiphony. **That fallback has since been retired** —
`packages/bff-client/rate-limit.ts` says so explicitly ("the old `CORE_API_BASE_URL`
fallback was retired in E2"), and `server-proxy-http.ts` records removing the second
arm from every method. Nothing in Vox Pop resolves `CORE_API_BASE_URL` today.

Vox Pop has also moved well past what these routes offered: `session-verifier.ts`
verifies **Ed25519 session JWTs against a JWKS** derived from `VOXPOP_API_BASE_URL`.
They built the asymmetric-JWT identity layer themselves, on their own side of the
seam, which is exactly where the boundary spec put it.

**Consequences for this migration:**

- **Firebase Auth leaves Antiphony entirely.** Delete the routes; there is nothing to
  port. `createCustomToken`, `createUser`, `deleteUser`, `createSessionCookie` all go.
- **`jose` is not needed for end-user identity.** Antiphony stops minting end-user
  credentials. It remains an *option* for hardening `requireSystemAuth`, on its own
  merits — see the section below, now much smaller.
- **Three of the five stragglers evaporate**, along with the `users`, `handles`, and
  `atproto_oauth_states` collections. Only rate-limit and idempotency need ports.
- **The largest cross-repo risk is gone.** It was already-completed work, not pending
  work. Nothing needs coordinating with Vox Pop to delete dead routes.

**A fifth route is dead too.** Stream 4 F7 **G2** moved the rate-limit check endpoint
onto the Vox Pop BFF, which now serves it itself — `packages/bff-client/rate-limit.ts`
resolves only `VOXPOP_API_BASE_URL`. So `POST /api/v1/system/rate-limit/check` also has
no external caller. Note the distinction that matters: the **route** is dead, but
`checkRateLimit()` is still what every `rateLimit(...)` middleware in core calls
in-process. The function stays; only the HTTP surface goes.

**✅ The checkmark in [`core-bff-boundary.md`](./core-bff-boundary.md) is corrected**
(2026-08-16). It claimed these were removed from core. They were removed from Vox Pop's
*dependency
on* core, which is a different statement, and the gap between the two is what made
this look like an open question.

## Reconciling PR #78 — the `mp3` rendition stage

[PR #78](https://github.com/bbthorson/antiphony/pull/78) proposes
`specs/mp3-rendition-stage.md`: a third stage class `RENDITION_STAGES` with derived
invalidation semantics and stored-blob output, surfacing `mp3BlobCid` on the post
view. It was written before the R2 and lazy-transcode decisions here, and it **does
not fully agree with them.** The disagreement is worth resolving explicitly rather
than letting two specs drift.

### What PR #78 gets right and must survive

**`mp3` must not be a byte-mutating stage.** `BYTE_MUTATING_STAGES` compose into
`processedBlobCid`, and the read view swaps playback to that variant — so mp3 joining
that class would serve **every web, embed, and mobile listener mp3 instead of opus**,
a quality regression for everyone to satisfy one consumer's codec limitation. The PR
also names why it would survive review: mp3 produces bytes, so "byte-mutating" is the
intuitive bucket, and no test asserting a stage reached `ready` would catch it.

This analysis is correct and independent of everything else here. Whatever shape
renditions take, they stay out of the playback-resolution path.

### Where it conflicts

| | PR #78 | Decided here |
| :--- | :--- | :--- |
| **When** | Eager — a pipeline stage, opted into via `PATCH` | Lazy — transcode when a consumer asks |
| **Addressing** | Content-addressed, `mp3BlobCid` on the post view | `renditions/{app}/{cid}.{format}`, not on the view |
| **Format selection** | A named field per format | Generic `?format=` on the audio route |

The PR **already names this design as its own documented fallback** — "a `?format=mp3`
query param baked into the signed URL … if one URL resolving per-format is ever
wanted." The requirement stated 2026-08-16 ("allow the requester to ask for the file
type") is precisely that, so the fallback is now the primary.

The generic param is also the only one that scales. `mp3BlobCid` as a view field
means `wavBlobCid` and `m4aBlobCid` follow it, each a schema change to the published
contract.

Two of the PR's four open questions are answered by decisions made after it was
written: **blob-signing ownership** (§ 1) dissolves — the proxy streams bytes and
signs nothing — and **R2** (§ 2) is confirmed as the destination, so renditions should
land there and never be migrated twice.

### Where PR #78 is right and the lazy decision is wrong

**Twilio latency.** A cold transcode on the first `<Play>` fetch is dead air on a live
call. The PR's telephony argument is specifically about *deleting* that class of
failure — `resolvePromptAudio`'s probe-and-fallback, its timeout budget, its
cold-start race, its spoken-title degradation. Pure lazy re-introduces a variant of
the exact problem the PR exists to remove.

### Recommended reconciliation

**Generic `format` as the interface; eager-vs-lazy as policy.**

- The route contract is `?format=` on the audio proxy, resolving
  `renditions/{app}/{cid}.{format}`. One URL shape, any format, no per-format field
  on the published view.
- A tenant that needs a rendition warm before first fetch **pre-warms** it through the
  existing `processing` opt-in on `PATCH /api/v1/posts/{postId}` — which PR #78
  correctly observes is already built, so this is a schema addition, not a new
  endpoint.
- Anything not pre-warmed transcodes on demand and caches. Same storage path, same
  route, same cache.

Vox Pop pre-warms mp3 and Twilio never pays a cold transcode; a creator downloading
wav six months later gets it lazily without Antiphony having stored wav for every
post ever. PR #78's stage-class separation stays intact — renditions keep derived
invalidation semantics and stay out of playback resolution — it just becomes a
pre-warm trigger for a cache rather than the only way bytes come into existence.

[`core-bff-boundary.md`](./core-bff-boundary.md) lists this block under **"Moved to
the BFF — ✅ removed from core"**:

- `POST /api/v1/system/auth/mint-session-cookie`
- `PUT /api/v1/system/users/{uid}/bluesky-identity`
- `POST /api/v1/system/atproto` (signin)
- `/api/v1/system/atproto-state/*`
- `/api/v1/system/atproto-session/*`

**They are all still mounted in [`app.ts`](../apps/core-api/src/app.ts), and there is
no removal commit in their history.** The checkmark is accurate for the *public*
trim — `/api/v1/users/*`, `/actors/*`, `/resolve/{handle}`, `/atproto/disconnect` are
genuinely gone, as [`core-surface.md`](./core-surface.md) records. The `/system/*`
half of that same decision never executed, and the spec says it did.

This is not a documentation nit. It is **upstream of the entire migration**, because
those five routes are:

- **100% of the Firebase Auth surface.** Every `createCustomToken`, `createUser`,
  `deleteUser`, and `createSessionCookie` call in the codebase is in this block.
- **Three of the five stragglers** in § The five stragglers.
- **The owners of three collections** — `users`, `handles`, `atproto_oauth_states`.

So the Neon schema cannot be designed until this is resolved. There is no point
modelling `users` and `handles` in Postgres if the decision already on paper says
they belong to the BFF.

**If the boundary spec's intent still holds**, the migration shrinks substantially:

- Firebase Auth leaves Antiphony entirely — no `jose` needed for end-user identity,
  because Antiphony stops minting end-user credentials at all.
- Three straggler ports never need writing; the routes are deleted instead.
- The cross-repo Vox Pop coordination flagged below as the migration's largest risk
  stops being *migration-induced* work and becomes *already-planned* work that the
  migration merely dates.
- `UserService` and `users-dependencies` likely go with them, since handle claiming
  is BFF-owned under the same principle table.

**If it no longer holds** — if these routes are load-bearing for Vox Pop today and
the boundary decision quietly reversed — then the `jose` work below is real and the
`users` / `handles` tables are Antiphony's to model.

Either answer is workable. What does not work is discovering which one is true
halfway through writing Postgres adapters. **Resolve this first**, and correct the
checkmark in `core-bff-boundary.md` whichever way it goes.

## Firebase Auth → jose

> Conditional on the section above. If the `/system/*` block is deleted per the
> boundary spec, most of this evaporates.

This is the part that needs the most care, and the part where "use jose 6" is
correct but under-specifies the work. There are **three** credential systems in this
codebase and they are frequently conflated:

**1. Service tokens** (`requireServiceToken` / `requireAuth`) — opaque strings from
`ANTIPHONY_APP_TOKENS`, constant-time compared. No Firebase. Runs on Workers as-is.
`jose` is neither needed nor obviously wanted here; the registry-collection upgrade
that [`service-auth.ts`](../apps/core-api/src/middleware/service-auth.ts) names as its
own swap point is a separate question from this migration.

**2. System auth** (`requireSystemAuth`) — a shared-secret bearer. Also no Firebase,
also runs on Workers unchanged. `jose` *could* replace it with asymmetric JWTs, and
[`system-auth.ts`](../apps/core-api/src/middleware/system-auth.ts) explicitly names
itself the swap point — but note that the strongest argument for doing so (the Cloud
Tasks token-storage exposure) **evaporates on Queues**. What remains is the
per-caller-key argument for multiple tenant BFFs, which is real but is a decision on
its own merits, not a migration requirement.

**3. Firebase Auth proper** — this is the one that must be rewritten:

- [`system-auth-mint.ts:90`](../apps/core-api/src/adapters/inbound/rest/system-auth-mint.ts:90)
  — `createSessionCookie(idToken)`
- [`system-atproto-signin.ts`](../apps/core-api/src/adapters/inbound/rest/system-atproto-signin.ts)
  — `createUser({})`, `createCustomToken(uid)`, `deleteUser(uid)` on the rollback path

`jose` 6 is exactly the right tool: it is WebCrypto-only with no Node polyfill, works
on Workers as a drop-in, and covers the whole surface. The replacement shape is
`SignJWT` with an EdDSA or ES256 key on mint, and either `jwtVerify` server-side or a
published JWKS endpoint so tenant BFFs verify locally without a call home.

**Two things make this the largest item in the migration, and neither is technical:**

- **It removes Firebase from the tenant's client, not just from core-api.** Today the
  flow is: core-api mints a Firebase *custom token* → the BFF hands it to the browser
  → the Firebase JS SDK exchanges it for an *ID token* → the BFF posts that back to
  `/mint-session-cookie`. Replacing the middle of that chain means Vox Pop's client
  changes too. This is a coordinated cross-repo change with a real cutover.
- **Firebase Auth currently mints the uid.** `createUser({})` generates the uid that
  becomes `authorId` on every post and the doc id in `users` and `handles`. Those uids
  must be preserved verbatim through the migration — the `users` table becomes the
  identity source of truth and existing uids import as-is. A regenerated uid space
  orphans every post ever written.

## The boot gate — resolved

`src/index.ts` runs `validateAllPins` before serving: it resolves every tenant's
`did:web`, proves the document names our PDS, snapshots the result in memory, and
`process.exit(1)`s on any failure. `getAppDid()` is a **synchronous** accessor that
serves only from that snapshot, so a DID whose custody was never proven cannot reach
an `at://` uri. The no-traffic → smoke-test → promote dance in
[`deploy.yml`](../.github/workflows/deploy.yml) exists to protect it.

Workers have no boot phase. But before designing a replacement, it is worth being
precise about what the current gate actually delivers — because it is less than it
appears, and that changes what "no regression" means.

### The property is weaker than it reads

**The snapshot is taken once and served forever.** A process up for thirty days is
answering with a thirty-day-old custody proof. If a tenant's DID document changes
after boot to point its `#atproto_pds` somewhere else, this deployment keeps minting
`at://` uris under that authority until something happens to restart it.

So the guarantee is not "we have proven custody." It is **"we had proven custody at
process start."** Which means a per-request check against a cache with, say, a
one-hour TTL is not a degradation at all — it is *strictly stronger* than what runs
in production today on a long-lived instance.

There are really two separable properties tangled together here, and the boot gate
serves one well and the other by accident:

1. **Deploy-time correctness** — the pins we are shipping are valid. Catches a typo
   in `ANTIPHONY_APP_DIDS`, a DID with no `#atproto_pds`, a host mismatch. This is
   the high-probability failure, and it is entirely knowable before traffic.
2. **Ongoing custody** — the DID *still* points at us. Catches revocation or
   takeover. Low probability, high severity, and the current design only checks it
   when a process happens to restart.

The replacement should serve both **deliberately** rather than conflating them.

### The design

**1. Deploy gate in CI.** Run `validateAllPins` against the config about to ship, as
a workflow step. This is a faithful port of today's semantics and it is *better*:
today a bad pin fails the deploy after the revision is built and pushed, and the
whole smoke-test-then-promote apparatus exists to contain that. In CI it fails
before anything ships. `checkTenantRegistryDrift` moves here too — it is config
drift between two env vars, fully knowable at deploy time, and it has no business
being a runtime warning nobody reads.

**2. Lazy per-tenant validation, folded into the auth middleware.** `requireAuth()`
and `requireServiceToken()` already resolve `originAppId` — they are the tenancy
boundary, and the pin is a tenancy property, so the check belongs in the same place
rather than in a fourth middleware that has to be ordered against them. They `await`
the pin check after matching the token; by the time a handler runs, the isolate's
snapshot is populated and **`getAppDid()` stays synchronous.**

That last part matters more than it sounds: making the port async would ripple
through `AudioPostService` and `AudioProcessingService` for no benefit. Doing the
async work in middleware keeps `packages/core` untouched.

The queue consumer needs the same call at the top of its handler — it runs outside
any request, and `AudioProcessingService.process` reaches `getAppDid` through
`buildPostUri`.

**3. A cache that distinguishes "couldn't check" from "checked and it's wrong."**
This is the load-bearing subtlety. Three layers:

- **Isolate-local** — the existing `validatedPins` Map already does this. Warm
  isolates pay nothing.
- **KV**, TTL ~1h, shared across isolates so a cold isolate does not re-fetch a
  `did:web` document that another isolate validated a minute ago.
- **Failure handling split by kind:**
  - A **positive disproof** — `pds-endpoint-host-mismatch`, `did-doc-id-mismatch`,
    `no-atproto-pds-endpoint` — is evidence the custody claim is false. Evict and
    fail closed immediately.
  - A **transient failure** — timeout, 5xx, network error — is absence of evidence,
    not evidence of absence. Serve the last-known-good snapshot if it is within a
    staleness bound (24h is a reasonable start), log loudly, and retry on the next
    request. Fail closed only when there is no known-good or it is too stale.

This distinction directly fixes a complaint the deploy workflow already documents
about itself: *"A deploy can therefore fail for a reason that has nothing to do with
this commit — a did:web host being briefly unreachable is enough."* Under the split,
a blip no longer takes anything down.

**4. A Cron Trigger for drift.** Hourly revalidation of every pin, off the request
path, purely to log and alert. This is the piece that actually delivers property (2)
— and it is the piece today's design lacks entirely. It also means revocation is
noticed on a low-traffic service, where lazy validation alone might not re-check for
a long time.

### Three ways this beats the current gate

- **Ongoing custody is genuinely checked**, hourly, instead of only when a process
  restarts.
- **Blast radius is per-tenant.** Today one bad pin fails the whole boot and takes
  every other tenant down with it — `validateAllPins` throws on the first failure.
  Per-request validation 503s the offending tenant and leaves the rest serving.
- **A transient `did:web` outage stops being an outage**, because absence of evidence
  is handled differently from disproof.

### What it costs

One `did:web` fetch per tenant per KV TTL, on a cold path, bounded by the existing
5s timeout. With one tenant in beta that is approximately nothing. The honest cost is
**conceptual**: "fail-closed at boot" is a single sentence, and this is four
mechanisms. The mitigation is that each one has a distinct job and the CI gate alone
covers the failure that actually happens.

### Deleted with the process

`installShutdownHandlers` and `lib/shutdown.ts` go — there is no process to drain.
The deploy workflow's no-traffic/smoke-test/promote sequence loses its rationale and
collapses to a normal `wrangler deploy` plus the CI gate above.

## The five stragglers

Five call sites reach `firebase-admin` directly with no port between them and the
service layer. These are the actual porting work, because unlike the adapters there is
no seam to swap:

| File | What it does |
| :--- | :--- |
| [`middleware/rate-limit.ts`](../apps/core-api/src/middleware/rate-limit.ts) | Firestore transaction on `rate_limits/{key}` + a module-scoped circuit breaker |
| [`lib/idempotency.ts`](../apps/core-api/src/lib/idempotency.ts) | Firestore transaction on `idempotency_keys` + `node:crypto` `createHash` |
| [`rest/system-atproto-state.ts`](../apps/core-api/src/adapters/inbound/rest/system-atproto-state.ts) | Direct Firestore CRUD on `atproto_oauth_states` |
| [`rest/system-atproto-session.ts`](../apps/core-api/src/adapters/inbound/rest/system-atproto-session.ts) | Direct Firestore CRUD on the session store |
| [`rest/system-atproto-signin.ts`](../apps/core-api/src/adapters/inbound/rest/system-atproto-signin.ts) | Firebase Auth + direct Firestore batch on the rollback path |

Putting ports in front of these was the single highest-value piece of prep, and the
prediction held: it converted the rest of the migration from a rewrite into a set of
adapter swaps. ✅ **All five are resolved** — three evaporated with the dead routes
(#83) and the remaining two got ports in #86.

One caveat that only surfaced in 3b, worth recording because the same shape can
recur: a port is not reached just because it exists. Both `middleware/rate-limit.ts`
and `lib/idempotency.ts` kept a *default argument* pointing at the Firestore binding,
and no caller ever passed another — so the ports were in place, the Postgres bindings
were written and tested, and production could not reach them by any configuration.
The seam was real and the wiring was not.

## Smaller items

- **`pino` → a structured-console logger** behind the existing `Logger` port. Pino
  works on Workers with caveats; the port makes a 20-line replacement trivial.
- **`Buffer` → `Uint8Array`.** `nodejs_compat` covers it, but note the `BlobStore`
  port itself types `upload(buffer: Buffer)` and `download(): Promise<Buffer | null>`.
  A Node type in a port signature is a leak in an otherwise clean boundary and should
  be `Uint8Array` regardless of where this lands.
- **`node:crypto` `createHash` → `crypto.subtle.digest`** in `idempotency.ts` (async,
  so the call site changes slightly).
- **The origin lock becomes dead code.** `originLock()` and `ANTIPHONY_ORIGIN_SECRET`
  exist to prove a request arrived through Cloudflare rather than at the bare
  `*.run.app` hostname. On Workers there is no origin to bypass. Delete the
  middleware, the config, and the deploy runbook section — noting that
  [472d1d5](https://github.com/bbthorson/antiphony/commit/472d1d5) enforced it three
  commits ago, so this should be raised before more is built on it.
- **Rate limiting — the constraint that shaped this has expired.** The earlier
  reasoning here was that shared buckets had to stay queryable over HTTP, because
  `POST /api/v1/system/rate-limit/check` let sibling BFFs share the *same* buckets and
  a native binding is per-Worker. **That is no longer true** — Vox Pop's BFF serves its
  own check endpoint now (see § Resolved), so nothing external shares these buckets.
  With the sharing requirement gone, both cleaner options open up: Cloudflare's native
  Rate Limiting binding, or the Durable Object recommended in § Where the metadata
  lives. The Postgres table in the draft schema is a bridge, not a destination.
- **Tests.** Most suites are pure and unaffected — the hexagonal split is doing its
  job. Anything touching bindings wants `@cloudflare/vitest-pool-workers`.
- **`wrangler.jsonc` becomes multi-worker.** The root config today is the assets-only
  docs Worker. A second Worker with a `main`, R2/Queue/Hyperdrive bindings, and its own
  environments needs per-app configs — and the file's own header comment ("Nothing in
  this file touches [core-api]") stops being true.

## Secrets: where each credential lives, and where it must not

Worth stating explicitly because the obvious answer is wrong in one place. R2
bucket: **`antiphony-r2-bucket`**, one bucket with two prefixes (`blobs/` and
`renditions/`).

| Consumer | Holds | Notes |
| :--- | :--- | :--- |
| Worker secrets | `SYSTEM_AUTH_TOKEN`, `ANTIPHONY_APP_TOKENS`, `ELEVENLABS_API_KEY` | **Not** the database. **Not** R2. |
| Hyperdrive resource | the Neon connection string | `wrangler hyperdrive create` |
| Rendition service (Cloud Run) | R2 **S3 API** key + secret, `SYSTEM_AUTH_TOKEN` | The only place a stored R2 key is unavoidable |
| An operator's shell / CI | Neon connection string; a read-only GCS service account | Schema apply + migration only |

**The database does not belong in a Worker secret.** With Hyperdrive the
connection string lives on the Hyperdrive resource and the Worker reads
`env.HYPERDRIVE.connectionString` — a local pooled string, not the Neon
credential. `wrangler secret put DATABASE_URL` is the move only if Hyperdrive is
skipped, and § Geography argues it should not be.

**R2 needs no credential in the Worker at all.** Binding-based authorisation is
why the R2 blob store has no signing code — and why dropping `getSignedUrl` made
the binding simpler rather than harder. The Cloud Run rendition service is the
exception, because it runs outside the Workers runtime and cannot hold a binding.

**Cloudflare secrets are write-only from outside.** Nothing reads one back, which
is exactly why the schema apply and the data migration cannot use them: those run
in a shell, against Firestore and Neon, with no Worker involved.

## Step 2d — the migration runbook

> ### ⛔ Precondition, learned the hard way on 2026-08-17
>
> **Both halves must be complete BEFORE `api.antiphony.dev` points at the Worker.**
> Not "around the same time" — before.
>
> The two halves are order-free *with respect to each other*. They are **not**
> order-free with respect to the DNS cutover, and this document previously only
> implied that. On 2026-08-17 the domain was repointed first and neither migration
> had run, so the platform served an empty database and an empty bucket for ~20
> minutes: every post 404'd, every blob 404'd, and every downstream consumer went
> dark with it. See § Execution record below.
>
> Nothing was lost and rollback was always available — but the outage was free to
> avoid by ordering, and reading "migrate the data once and switch" as a sequence
> rather than a pair is the whole of the fix.

Two independent halves. **Object paths are unchanged across the move**
(`blobs/{originAppId}/{cid}`), so no record needs rewriting to point at the new
bucket — a property of content addressing, and the reason these can run in
either order or concurrently.

**Blobs — Cloudflare Super Slurper, no code.** R2 → Data Migration in the
dashboard copies GCS → R2 natively, given a service account with
`Storage Object Viewer` plus `storage.buckets.get`. It handles resumption,
parallelism and verification better than a bespoke loop would, and needs no R2
credential on our side. Objects over 1 TB are skipped; nothing here approaches
that (the upload route caps at 25 MB).

**Records — `npm run migrate:firestore-to-neon -w @antiphony/core-api`.** Run by
an operator with `DATABASE_URL` and `GOOGLE_APPLICATION_CREDENTIALS` in the
environment. `--dry-run` reads and validates without writing.

It **verifies itself**: every migrated post is read back and its CID recomputed,
and the script exits non-zero on any drift. That check is inline rather than a
later audit because the failure is silent — `jsonb` stores numbers as `numeric`,
wider than JS, so a coercion would change a record and invalidate every
StrongRef pointing at it while both sides continued to agree with themselves. A
drift caught during the run is one record to investigate; caught afterwards it is
an unknown subset.

Re-running is safe: every write is an upsert keyed on the record's own id, so a
partial run resumes by running again. Nothing is deleted from Firestore —
cutover is a config change and rollback is pointing back at the old binding.

## Execution record — 2026-08-17

What actually happened, in order, because the ordering is the lesson.

| Time (UTC) | Event |
|---|---|
| 22:05:08 | `api.antiphony.dev` repointed to the Worker. `/health`: `backend: postgres` |
| ~22:06 | Downstream voice call fails — the consuming app reports "the user has not set up a voicemail" |
| 22:0x | Diagnosis: Neon empty (0 posts) **and** R2 empty (blobs 404) |
| ~22:3x | `migrate:firestore-to-neon` run: **14 posts, 11 transcripts, `cidDrift: 0`** |
| after | Records restored; audio still 404 pending Super Slurper |

Neither data migration had been run. Firestore and GCS were untouched throughout —
the sources still held everything, which is why this was an availability incident
and not a data one.

### What the failure looked like from outside

Worth writing down, because none of it looked like an outage:

- **`/health` returned `{"ok":true, ..., "backend":"postgres"}` the entire time.**
  It reports which backend is *wired*, not whether that backend has anything in it,
  so the status surface read green across an empty database. **This is worth
  fixing** — a row count, or a `records: present|empty` signal, would have turned a
  20-minute diagnosis into a glance.
- **Every response was a well-formed success.** Post listings returned
  `{"success":true,"data":{"items":[],"nextCursor":null}}`. A *successful query
  returning zero rows* is indistinguishable from "this user has nothing" at every
  layer above it — which is exactly how a consuming app ended up telling a caller
  the account had no voicemail set up.
- **The 404s were honest and unhelpful.** A blob request 404s identically whether
  the CID is wrong or the bucket is empty.

The one signal that *did* discriminate: an empty result from a query that
succeeded, on a tenant known to have data. Nothing surfaced that automatically.

### Verifying a cutover — the checks that actually distinguish states

Run these against the Worker before repointing anything at it. Each is chosen
because it fails differently for a different cause.

```bash
# 1. Records present? (Not just "does the query work" — a working query on an
#    empty database is the failure mode above.)
curl -s 'https://api.antiphony.dev/api/v1/posts?kind=prompt&limit=1' \
  -H "Authorization: Bearer $ANTIPHONY_SERVICE_TOKEN" \
  -H "X-Antiphony-Acting-Actor: <a uid known to have posts>"
# items: [] on a tenant with posts  ->  Neon is empty. Run the records migration.

# 2. Blobs present? Ask for one whose CID you know exists.
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
  'https://api.antiphony.dev/api/v1/audio?url=blobs/<originAppId>/<cid>'
# 404 -> R2 is empty. Run Super Slurper.  200 + real bytes -> blobs are there.

# 3. Schema present? (Distinguishes "empty tables" from "no tables at all".)
#    A missing table ERRORS; an empty one returns success with zero rows. So if
#    check 1 returned a clean empty list, the schema exists and only data is
#    missing — which is the good case, and means the migration is a plain insert.
```

### Rollback

Point `api.antiphony.dev` back at the Cloud Run service. The old revision remains,
Firestore and GCS are untouched, and the records migration deletes nothing — so
the pre-cutover path stays fully intact until it is deliberately retired. Cutover
is a config change in both directions.

### Operational traps found the same day

Two more, both in this project's Cloud Run era, both worth knowing before the next
infrastructure change:

- **`ANTIPHONY_PUBLIC_BASE_URL` unset for a day.** Declared required in the `0.5.0`
  CHANGELOG, but its absence only degraded: `audioPlaybackUrl` returned null and
  every post view hydrated with **no `embed`**, logging an error per hydration and
  serving "no audio" rather than failing. **A required variable whose absence merely
  degrades will not be noticed.** Assert required config at startup instead.
- **A config-only `gcloud run services update` applied nothing, and reported
  success.** The service's traffic was pinned to a named revision — correctly, as
  the output of the smoke-gated `build · deploy · smoke · promote` pipeline — so the
  update created a revision that received 0% of traffic while the CLI printed the
  *old* revision as "serving 100 percent of traffic". Image deploys were never
  affected; only config-only updates strand. Apply config through the pipeline, or
  `update-traffic --to-revisions=<new>=100` after.

The shape all three share, including the empty-database incident: **the tool
reported success, the documentation asserted the intended state, and only
behaviour disagreed.** Assertions that run in the pipeline are the only ones that
fail loudly.


## Sequencing

**Revised 2026-08-16.** The original six-phase plan was paced for a service with
users to protect. It has one operator in beta testing, so most of that caution is
buying nothing. What follows is the compressed version; the reasoning for the long
one is kept at the end because it becomes right again the moment a second tenant
onboards.

What the beta framing removes:

- **No dual-write, no backfill window, no read cutover.** Migrate the data once and
  switch. Dual-writing exists to keep a live read path correct during a transition;
  there isn't one.
- **No "stay on Cloud Run to keep it debuggable" phases.** That was hedging against
  breaking production, and the hedge costs more than the risk.
- **No jose phase at all.** Deleted with the dead routes.

- **Step 1 — delete the dead `/system/*` routes.** ✅ **Done 2026-08-16.** Six routes,
  `UserService`, the `UserDependencies` port and binding, and `getAdminAuth()` are
  gone; Firebase Auth is out of the service entirely and the `users` / `handles` /
  `atproto_oauth_states` collections have no writer. The public OpenAPI surface is
  byte-identical. Cheapest step, largest reduction in every later one.
- **Step 2 — schema + adapters + R2, together.** Apply
  [`apps/core-api/db/schema.sql`](../apps/core-api/db/schema.sql), write the Postgres and R2 bindings behind
  the existing ports, one-shot the data across, verify CID round-trip stability.
  Ports for rate-limit and idempotency fold in here rather than being their own
  phase. The TTL sweep lands with the schema.
- **Step 3 — the Worker.** ✅ **Done 2026-08-16** (3a in #89; 3b–3e on
  `claude/cloudflare-migration-steps`). Runtime swap, Queues replacing Cloud Tasks,
  boot-gate replacement, origin lock deleted, `rate_limits` to a Durable Object,
  per-app wrangler configs. The streaming audio proxy landed earlier, in #87.
  Cloud Run was retired with it — see § Status.
- **Step 4 — ffmpeg consolidation.** Bring `apps/audio-rendition` under Antiphony,
  add `format`, move `trim` and `waveform` onto it, retire the Vox Pop copy.

**Step 4 stays last, and its pace is not ours to set.** Vox Pop is mid-cutover on
that service's extraction and it sits on a **live Twilio path** — real calls, real
callers. The beta framing that compresses steps 1–3 applies to Antiphony, not to
Vox Pop's telephony. Let the extraction soak and land its step 5 first.

The two decisions worth taking early even under compression: the **TTL sweep**
(silent, slow failure otherwise) and **CID round-trip verification** (silent data
corruption otherwise). Both are cheap now and expensive to discover later.

<details>
<summary>The original phased plan — right again at a second tenant</summary>

Phase −1 delete dead routes → Phase 0 port stragglers → Phase 1 Neon on Cloud Run
with dual-write and backfill → Phase 2 R2 on Cloud Run → Phase 3 identity cutover →
Phase 4 Worker. Each phase leaves the service on a debuggable runtime; phases 0–3
deliver value on Cloud Run alone, so an abandoned migration strands nothing.

</details>

## Open questions

1. **PR #78 reconciliation** — does the pre-warm-plus-lazy compromise hold, or does
   Twilio latency argue for keeping renditions a genuine eager stage?
2. **Rendition rate-limit key**: what replaces the IP-keyed `RATE_LIMITS.read` on the
   path Twilio fetches? Blocks the telephony cutover, not the migration.
3. **Where does the ffmpeg service sit?** Now that the database is AWS `us-east-1`
   and Cloud Run is `us-east4`, keeping `audio-rendition` in `us-east4` keeps it
   next to both the database and (eventually) wherever Smart Placement parks the
   Worker. Worth confirming rather than inheriting.

### Answered

- **ffmpeg** — consolidate onto Vox Pop's `apps/audio-rendition`, moved under
  Antiphony ownership, growing to host the ingest stages. Not Cloudflare Containers.
  Sequenced after its current cutover soaks.
- **Rendition storage** — Antiphony owns the blob, canonical and derived. Consuming
  services store their own application metadata. Renditions live at
  `renditions/{originAppId}/{sourceCid}.{format}`.
- **Eager vs lazy** — **deferred to [`mp3-rendition-stage.md`](./mp3-rendition-stage.md)**,
  which is the decision of record for the `mp3` stage and lands on eager via a
  per-tenant create-time opt-in. That is the right call for the Twilio path (a
  cold transcode on first `<Play>` is dead air on a live call) and it is not
  actually in tension with lazy-by-default: an opt-in costs nothing for tenants
  that never phone anything. Any format NOT covered by an opt-in stage still
  resolves on demand.
- **Audio proxy** — streams bytes rather than 302-ing to a signed URL. Settled by the
  rendition decision: a 302 cannot point at bytes that do not exist until the first
  request creates them.
- **Metadata store** — Neon, not D1. Portability is the deciding argument: the ports
  exist so a self-hoster can run this on their own Postgres, and D1 would make the
  reference implementation Cloudflare-only. `rate_limits` is the exception and belongs
  in a Durable Object.
- **Boot gate** — replaced by four separate mechanisms rather than one: a CI deploy
  gate, lazy per-tenant validation folded into the auth middleware, a stale-tolerant
  cache that distinguishes disproof from unreachability, and an hourly Cron Trigger
  for drift. Net stronger than today, because today's snapshot is taken once per
  process lifetime and never refreshed.
- **Origin lock** — ✅ deleted in 3d, together with `src/index.ts` and the Cloud Run
  deployment. The two could not be separated: deleting the lock while Cloud Run still
  served would strip the `*.run.app` hostname of its only gate, and keeping the Node
  entry while deleting the lock is incoherent. So "the runtime moves" became a single
  decision rather than a sequence.
- **Driver** — start on `@neondatabase/serverless` (HTTP). Deleting the dead routes
  takes `users`/`handles` with them, and the handle swap was the only operation
  wanting an interactive transaction — so the HTTP driver's batch-only limitation no
  longer binds. **Hyperdrive at step 3 is now expected rather than optional**, given
  the `us-east-1` geography; the ports keep it a late-binding choice either way.
- **Database** — Neon on AWS `us-east-1`, Postgres 18. Two consequences already
  folded into [`apps/core-api/db/schema.sql`](../apps/core-api/db/schema.sql): PG18 makes generated columns
  `VIRTUAL` by default and virtual columns cannot be indexed, so the explicit
  `stored` keyword is load-bearing; and PG18 skip scan does **not** let one index
  serve both author queries, because the trailing column is a sort key.
