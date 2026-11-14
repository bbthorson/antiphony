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

Baseline it once, which records migrations as applied without executing them.
**Always pass `--until <the last file the database has>`.** A bare `--baseline`
records every pending file, so the ledger would claim tables and columns the
database may never have had. A database built from the old `db/schema.sql` has
`0001`; check whether anyone also ran later files by hand (for `0002`: does a
`spaces` table exist?). Preview first, then record, then let a plain `migrate`
apply the rest:

```bash
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --baseline --until 0001 --dry-run
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api -- --baseline --until 0001
DATABASE_URL='postgresql://…' npm run migrate -w @antiphony/core-api
```

Only ever do this for migrations the database demonstrably already has. On a
genuinely empty database, skip it and let `migrate` apply the chain normally.

Until a database is baselined, `deploy.yml`'s migrate step fails on `0001`
(`relation "posts" already exists`) and the Worker is not deployed.

---

`users`, `handles` and `atproto_oauth_states` are absent by design: they went to the Vox Pop
BFF with the routes that owned them ([`specs/core-bff-boundary.md`](../../../specs/core-bff-boundary.md)).
The history of the move to Postgres is in [`specs/archive/cloudflare-migration.md`](../../../specs/archive/cloudflare-migration.md).

## Design rules the schema follows

  1. The canonical record is stored WHOLE, as jsonb. `AudioPostRecordSchema`
     stays the single source of truth and `safeParse` stays on the read path.
     Normalising into columns and
     reassembling would risk changing the record, and its CID with it.

  2. Query facets are GENERATED columns off that jsonb, not hand-written
     copies, so they can't drift from the record.

⚠️ TARGET IS POSTGRES 18, AND `STORED` BELOW IS LOAD-BEARING.

   Postgres 18 added VIRTUAL generated columns and made VIRTUAL **the
   default** — before 18, `GENERATED ALWAYS AS (…)` had to be STORED and the
   keyword was ceremony. A virtual column is computed on read and occupies no
   storage, so it CANNOT BE INDEXED. Every generated column in the chain is
   indexed. Dropping the `stored` keyword would still create the table, still
   pass a smoke test, and then fail at `CREATE INDEX` — or, worse, be dropped
   from a later column someone adds without one.

   Anyone writing a migration: the keyword is not optional.

  3. Mutable state lives OUTSIDE the record column. `processing` is patched
     per stage and `lease_until` is claimed on the hot path; both would
     otherwise force a rewrite of the whole record on every stage settle.


## The TTL sweep

`antiphony_sweep_expired()` (in `0001_initial_schema.sql`) deletes expired rows from
`idempotency_keys` and `rate_limits`. All of its policy (the tables, the predicate, the batch
size) lives in the function, so the caller is exactly what an operator would type:

```sql
select * from antiphony_sweep_expired();
```

The Worker's cron (`"triggers": { "crons": ["17 * * * *"] }` in `wrangler.jsonc`, off the hour
because :00 is the busiest minute on Cloudflare's scheduler) calls it once an hour through
`adapters/outbound/postgres/sweep.ts`. It's pure space reclamation: both upserts already treat
an expired row as absent. So a failure is logged and swallowed rather than failing the cron.
Not pg_cron: Neon only runs it while the compute is awake, and scale-to-zero is wanted.

Under the reference deployment the `rate_limits` half sweeps nothing, because buckets live in a
Durable Object. The table stays the store for a deployment without that binding, so a zero count
there is the expected reading, not a broken sweep.

## No table for renditions — deliberately

Renditions resolve at `renditions/{originAppId}/{sourceCid}.{format}`, which
is derivable from the request alone. Existence is an R2 HEAD, so the cache
needs no rows, no lookup, and no row to fall out of sync with the object.
This is the reason renditions are addressed by derivation rather than
content — see specs/archive/cloudflare-migration.md § Where renditions live.

## Checked by the suite

- **CID stability across jsonb.** DAG-CBOR canonicalises key order, so jsonb's reordering is
  harmless. The real risk is numeric coercion (jsonb numbers are `numeric`, wider than JS).
  `audio-posts-dependencies.test.ts` checks that a record's CID survives a write and read.
- **`processing` is split out of the record column.** The adapter strips it on write and puts
  it back on read before `safeParse` (`record-mapping.ts`, `splitRecord` / `hydrateRow`), and the
  same suite round-trips processing state across that split.
