# The Antiphony schema, and how to change it

The schema lives in `../migrations/` as a numbered chain, applied by
`../scripts/migrate.ts`. There is no `schema.sql` any more: it became
`0001_initial_schema.sql`, and every change since is its own file.

```bash
# against your own Neon branch
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api

# what is pending, without applying it
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --dry-run
```

## Writing a new migration

1. Add `NNNN_short_slug.sql` in `../migrations/`. Numbering is lexicographic,
   so keep the four digits.
2. Do **not** write `begin;` / `commit;`. The migrator wraps each file in its
   own transaction and inserts the ledger row inside it, so a file either
   applied and is recorded or neither.
3. Never edit a file that has been applied. The migrator checksums every one
   and fails loudly on a change.

The binding suites apply this same chain to an in-process Postgres 18 (PGlite)
and run the real adapters against it — see
`../src/adapters/outbound/postgres/testing/pglite.ts`. So a column renamed in a
migration breaks the suite immediately, and the schema's own claims get
exercised rather than asserted.

## ⚠️ Adopting the ledger on a database that already has the schema

`0001` describes the schema production has ALREADY been running since the
cutover, applied by hand with `psql -f db/schema.sql`. Running `migrate`
against such a database would try to apply `0001` and fail on the first
`create table` that already exists.

Baseline it once, which records the chain as applied without executing it:

```bash
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --baseline
```

Only ever do this for migrations the database demonstrably already has. On a
genuinely empty database, skip it and let `migrate` apply the chain normally.

---

Companion to specs/archive/cloudflare-migration.md. Moved here from specs/ once the
Postgres bindings began depending on it: adapters/outbound/postgres/*.test.ts
applies THIS FILE to an in-process Postgres 18 (PGlite) and runs the real
bindings against it, so a drift between the schema and the code that reads it
fails the suite rather than production. It is the same file you apply to Neon.

No migration tool is wired yet — this is still apply-once DDL, not a
versioned migration chain. That is the next thing to fix if the schema
changes after first deploy.

Scope assumes Phase −1 has landed (the dead /system/* routes deleted), so
`users`, `handles`, and `atproto_oauth_states` are absent by design — they
went to the Vox Pop BFF with the routes that owned them.

## Design rules the schema follows

  1. The canonical record is stored WHOLE, as jsonb. `AudioPostRecordSchema`
     stays the single source of truth and `safeParse` stays on the read path
     exactly as it is against Firestore. Normalising into columns and
     reassembling would risk changing the record, and its CID with it.

  2. Query facets are GENERATED columns off that jsonb, not hand-written
     copies. Firestore had them as ordinary fields that could silently drift
     from the record; here drift is impossible by construction.

⚠️ TARGET IS POSTGRES 18, AND `STORED` BELOW IS LOAD-BEARING.

   Postgres 18 added VIRTUAL generated columns and made VIRTUAL **the
   default** — before 18, `GENERATED ALWAYS AS (…)` had to be STORED and the
   keyword was ceremony. A virtual column is computed on read and occupies no
   storage, so it CANNOT BE INDEXED. Every generated column in this file is
   indexed. Dropping the `stored` keyword would still create the table, still
   pass a smoke test, and then fail at `CREATE INDEX` — or, worse, be dropped
   from a later column someone adds without one.

   Anyone editing this file: the keyword is not optional.

  3. Mutable state lives OUTSIDE the record column. `processing` is patched
     per stage and `lease_until` is claimed on the hot path; both would
     otherwise force a rewrite of the whole record on every stage settle.


## Scheduling the sweep

At step 3, the Worker gains a Cron Trigger. In wrangler config:

    [triggers]
    crons = ["17 * * * *"]      # hourly, off the hour

Off-the-hour deliberately: :00 is the busiest minute on Cloudflare's cron
scheduler, and this job has no reason to compete for it.

The handler is a drain loop with a hard cap, so a backlog cannot run the
Worker into its 15-minute scheduled-invocation ceiling:

    export default {
        async scheduled(_event, env, ctx) {
            ctx.waitUntil((async () => {
                const BATCH = 5000;
                for (let pass = 0; pass < 20; pass++) {
                    const rows = await sql`select * from antiphony_sweep_expired(${BATCH})`;
                    const max = Math.max(...rows.map((r) => Number(r.deleted)));
                    if (max < BATCH) return;        // drained
                }
                // Hit the cap with work left. Not an error — the next tick
                // continues — but it means the backlog is growing faster than
                // an hourly drain, which is worth a log line someone sees.
                console.warn('[ttl-sweep] cap reached with rows remaining');
            })());
        },
    };

Hourly is arbitrary but defensible: the shorter TTL of the two is the
rate-limit window (minutes to an hour), so hourly keeps `rate_limits` within
roughly one window of its true size, and `idempotency_keys` (24h TTL) is
swept far more often than it needs.

Note the `rate_limits` half sweeps nothing under the reference deployment,
which keeps its buckets in a Durable Object — an object resets its own window
in place and needs no reclamation. An earlier version of this comment said
that half should be deleted when that happened. It should not: the table
remains the store for a deployment with no Cloudflare bindings, and a sweep
that skips an empty table costs one statement. What IS worth knowing is that
a zero count there is the expected reading, not a broken sweep.

## No table for renditions — deliberately

Renditions resolve at `renditions/{originAppId}/{sourceCid}.{format}`, which
is derivable from the request alone. Existence is an R2 HEAD, so the cache
needs no rows, no lookup, and no row to fall out of sync with the object.
This is the reason renditions are addressed by derivation rather than
content — see specs/archive/cloudflare-migration.md § Where renditions live.

## Open questions

1. ~~TTL has no owner.~~ RESOLVED — see § TTL sweep above.
   `antiphony_sweep_expired()` ships with this schema; a Cloudflare Cron
   Trigger drives it from step 3. Not pg_cron: Neon only runs it while the
   compute is awake, and scale to zero is wanted here. No interim scheduler
   for the Cloud Run window — the sweep is pure space reclamation and beta
   volume is trivial; run it by hand if it ever looks large.

2. `FirestoreTimestampSchema` needs renaming. It already accepts ISO strings
   and transforms to `Date`, so jsonb round-trips work unchanged — but the
   name stops being true the moment Firestore is gone. Behavioural no-op.

3. Verify CID round-trip stability before trusting the jsonb column. DAG-CBOR
   canonicalises key order, so jsonb reordering is safe in theory. Numeric
   coercion is the real risk (jsonb numbers are `numeric`, wider than JS).
   The adapter suite wants a property test:
       cidForRecord(read(write(record))) === record.cid

4. `posts.record` still contains `processing` in the Zod type but not in this
   column. The adapter must strip on write and reassemble on read BEFORE
   `safeParse`, or the refine in AudioPostRecordSchema sees a record it does
   not expect. Worth a dedicated test.
