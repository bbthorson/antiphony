-- Antiphony on Neon — draft schema
--
-- Companion to specs/cloudflare-migration.md. This is a DRAFT for review, not a
-- migration: no migration tool is wired yet, and the § Open items at the bottom
-- are unresolved.
--
-- Scope assumes Phase −1 has landed (the dead /system/* routes deleted), so
-- `users`, `handles`, and `atproto_oauth_states` are absent by design — they
-- went to the Vox Pop BFF with the routes that owned them.
--
-- Design rules this file follows:
--
--   1. The canonical record is stored WHOLE, as jsonb. `AudioPostRecordSchema`
--      stays the single source of truth and `safeParse` stays on the read path
--      exactly as it is against Firestore. Normalising into columns and
--      reassembling would risk changing the record, and its CID with it.
--
--   2. Query facets are GENERATED columns off that jsonb, not hand-written
--      copies. Firestore had them as ordinary fields that could silently drift
--      from the record; here drift is impossible by construction.
--
-- ⚠️ TARGET IS POSTGRES 18, AND `STORED` BELOW IS LOAD-BEARING.
--
--    Postgres 18 added VIRTUAL generated columns and made VIRTUAL **the
--    default** — before 18, `GENERATED ALWAYS AS (…)` had to be STORED and the
--    keyword was ceremony. A virtual column is computed on read and occupies no
--    storage, so it CANNOT BE INDEXED. Every generated column in this file is
--    indexed. Dropping the `stored` keyword would still create the table, still
--    pass a smoke test, and then fail at `CREATE INDEX` — or, worse, be dropped
--    from a later column someone adds without one.
--
--    Anyone editing this file: the keyword is not optional.
--
--   3. Mutable state lives OUTSIDE the record column. `processing` is patched
--      per stage and `lease_until` is claimed on the hot path; both would
--      otherwise force a rewrite of the whole record on every stage settle.

begin;

-- ---------------------------------------------------------------------------
-- posts  (Firestore: `posts`)
-- ---------------------------------------------------------------------------

create table posts (
    -- A TID (13 lowercase alnum) minted by `newPostId()`. Also the `rkey` in
    -- at://{appDid}/{collection}/{rkey}, so it is a real record key, not a
    -- surrogate.
    id                text        primary key,

    -- Multi-tenant isolation key. Every query in `AudioPostDependencies` is
    -- scoped by it; it leads every index below for that reason.
    origin_app_id     text        not null,

    -- The canonical record, MINUS `processing` (see below). Reassembled as
    -- `{...record, processing}` before `AudioPostRecordSchema.safeParse` on read.
    record            jsonb       not null,

    -- ProcessingState minus `leaseUntil`. Its own column so `patchProcessingState`
    -- is `processing = coalesce(processing,'{}') || $patch` — a jsonb merge that
    -- touches one column, instead of rewriting the record on every stage settle.
    processing        jsonb,

    -- Promoted out of `processing` to a real typed column. The lease claim must
    -- be an atomic conditional UPDATE with an index behind it; reaching into
    -- jsonb for the comparison would be both slower and harder to read. This is
    -- the field the whole concurrency argument in
    -- ports/audio-processing-dependencies.ts rests on.
    lease_until       timestamptz,

    -- Written by the adapter rather than generated, unlike the facets below:
    -- `(record->>'createdAt')::timestamptz` is not IMMUTABLE (the cast depends
    -- on the TimeZone setting), so Postgres rejects it in a generated column.
    -- The check constraint keeps it honest instead.
    created_at        timestamptz not null,

    -- --- Generated query facets -------------------------------------------
    -- `jsonb ->>` is immutable, so these are all legal as STORED generated
    -- columns and cannot diverge from the record.
    cid               text        not null generated always as (record ->> 'cid') stored,
    author_id         text        not null generated always as (record ->> 'authorId') stored,
    kind              text        not null generated always as (record ->> 'kind') stored,
    root_author_id    text        generated always as (record ->> 'rootAuthorId') stored,
    reply_parent_uri  text        generated always as (record -> 'reply' -> 'parent' ->> 'uri') stored,

    constraint posts_kind_valid check (kind in ('prompt', 'reply')),

    -- The same invariant `AudioPostRecordSchema.refine` enforces in Zod, now
    -- also enforced by the database. A reply has a parent and a root author; a
    -- prompt has neither. Firestore could not express this at all.
    constraint posts_kind_matches_reply check (
        (kind = 'reply'  and reply_parent_uri is not null and root_author_id is not null)
     or (kind = 'prompt' and reply_parent_uri is null     and root_author_id is null)
    ),

    -- ⚠️ This cast is the same non-IMMUTABLE one that kept `created_at` out of
    --    the generated columns above, and Postgres permits it in a CHECK where
    --    it forbids it in a generated column — with the caveat that a
    --    non-deterministic constraint can fail on dump/restore under a
    --    different TimeZone setting.
    --
    --    It is safe HERE because every writer is `Date.toISOString()`, which
    --    always emits an explicit `Z` offset, and text→timestamptz is
    --    deterministic when the string carries an offset. The assumption is the
    --    constraint's precondition: anything hand-inserting a naive timestamp
    --    string breaks it. Worth knowing before writing a backfill by hand.
    constraint posts_created_at_matches_record check (
        created_at = (record ->> 'createdAt')::timestamptz
    )
);

-- The four composite indexes from firestore.indexes.json, plus `id` as a
-- tiebreaker so keyset pagination is total. Post ids are TIDs and therefore
-- time-sortable, so (created_at, id) is a well-ordered cursor and the extra
-- document read `startAfterCursor()` pays today disappears.

-- queryByAuthor, no kind filter.
create index posts_author_created_idx
    on posts (origin_app_id, author_id, created_at desc, id desc);

-- queryByAuthor with `kind`. Not served by the index above — `kind` sits
-- between the equality columns and the sort — so both are needed, exactly as
-- in Firestore.
--
-- Postgres 18's btree SKIP SCAN does not collapse these two into one, which is
-- worth recording so it is not re-litigated. Skip scan synthesises an equality
-- on an underspecified leading column and is aimed at cases where the LATER
-- columns are equality predicates. Here the trailing column is a SORT key: the
-- two skipped `kind` values would each yield their own created_at-ordered
-- stream, and producing a globally ordered result from them needs a merge the
-- index scan does not do — so the planner sorts, and the dedicated index wins.
create index posts_author_kind_created_idx
    on posts (origin_app_id, author_id, kind, created_at desc, id desc);

-- queryReplies. Ascending: thread reading order.
-- Partial, because `reply_parent_uri` is null on every prompt. Firestore had no
-- equivalent; this index covers only the rows that can ever match it.
create index posts_reply_parent_created_idx
    on posts (origin_app_id, reply_parent_uri, created_at asc, id asc)
    where kind = 'reply';

-- queryByRootAuthor — "replies to author X". Reply-only for the same reason.
create index posts_root_author_created_idx
    on posts (origin_app_id, root_author_id, created_at desc, id desc)
    where kind = 'reply';

-- Supports the lease sweep and any "what is stuck" operator query. Partial so
-- it holds only the handful of rows with a live claim.
create index posts_lease_idx
    on posts (lease_until)
    where lease_until is not null;

-- ---------------------------------------------------------------------------
-- audio_transcripts  (Firestore: `audio_transcripts`)
-- ---------------------------------------------------------------------------

create table audio_transcripts (
    id            text        primary key,
    record        jsonb       not null,
    created_at    timestamptz not null,

    subject_uri   text        not null generated always as (record -> 'subject' ->> 'uri') stored,
    subject_cid   text        generated always as (record -> 'subject' ->> 'cid') stored,

    -- Same deterministic-cast precondition as `posts_created_at_matches_record`
    -- above; see the note there before hand-writing any insert.
    constraint transcripts_created_at_matches_record check (
        created_at = (record ->> 'createdAt')::timestamptz
    )
);

-- The port documents `saveTranscript` as "last-write-wins by subject uri", but
-- Firestore could not enforce it — the read path carries a comment conceding
-- "last write wins if a post somehow has multiple transcripts", i.e. it was a
-- convention, not a constraint. A unique index makes the documented contract
-- the actual one, and turns the write into a plain
-- `INSERT ... ON CONFLICT (subject_uri) DO UPDATE`.
create unique index transcripts_subject_uri_key
    on audio_transcripts (subject_uri);

-- Note for the adapter: `getTranscriptsBySubjectUris` loses its 30-item
-- chunking (FIRESTORE_IN_LIMIT) and the Promise.all fan-out. It becomes one
-- statement: `where subject_uri = any($1)`.

-- ---------------------------------------------------------------------------
-- idempotency_keys  (Firestore: `idempotency_keys`)
-- ---------------------------------------------------------------------------

create table idempotency_keys (
    -- `{uid}_{sha256hex(key)}` — unchanged from lib/idempotency.ts. The hash
    -- keeps a client-supplied key path-safe and bounded; the uid prefix
    -- namespaces it per caller.
    id            text        primary key,
    status        text        not null,
    response      jsonb,
    created_at    timestamptz not null default now(),
    completed_at  timestamptz,
    expires_at    timestamptz not null,

    constraint idempotency_status_valid check (status in ('processing', 'completed'))
);

-- Drives the TTL sweep (see § Open).
create index idempotency_expires_idx on idempotency_keys (expires_at);

-- The three-branch read-then-write transaction collapses to one statement:
--
--   insert into idempotency_keys (id, status, expires_at)
--   values ($1, 'processing', now() + interval '24 hours')
--   on conflict (id) do update
--       set status = 'processing', created_at = now(), completed_at = null,
--           response = null, expires_at = excluded.expires_at
--       where idempotency_keys.expires_at < now()   -- expired ⇒ reclaim
--   returning status, response, (xmax = 0) as inserted;
--
-- No row returned ⇒ a live key exists: read it to decide 409 (processing) vs
-- cached replay (completed).

-- ---------------------------------------------------------------------------
-- rate_limits  (Firestore: `rate_limits`)
-- ---------------------------------------------------------------------------
--
-- PROVISIONAL. This table exists so rate limiting keeps working while the
-- service is still on Cloud Run. Once the Worker lands, this workload should
-- move to a Durable Object: it is a high-frequency counter write on the READ
-- path, which is the single worst thing to put behind a network hop to
-- Postgres. See specs/cloudflare-migration.md § Where the metadata lives.
--
-- Nothing external shares these buckets any more: Stream 4 F7 G2 moved the
-- check endpoint onto the Vox Pop BFF, which serves it itself. That removes the
-- one constraint that required the buckets to live somewhere HTTP-queryable, so
-- a Durable Object (or Cloudflare's native Rate Limiting binding) is now
-- unobstructed. This table is a bridge to that, not a destination.
--
-- `checkRateLimit()` the FUNCTION stays either way — every rateLimit(...)
-- middleware in core calls it in-process. It is the ROUTE that is dead.

create table rate_limits (
    key           text        primary key,
    count         integer     not null default 0,
    reset_time    timestamptz not null,
    expires_at    timestamptz not null
);

create index rate_limits_expires_idx on rate_limits (expires_at);

-- The whole transaction becomes one upsert that returns the post-increment
-- count; the caller compares against its limit:
--
--   insert into rate_limits (key, count, reset_time, expires_at)
--   values ($1, 1, now() + $2::interval, now() + $2::interval)
--   on conflict (key) do update
--       set count      = case when rate_limits.reset_time < now() then 1
--                             else rate_limits.count + 1 end,
--           reset_time = case when rate_limits.reset_time < now() then excluded.reset_time
--                             else rate_limits.reset_time end,
--           expires_at = excluded.expires_at
--   returning count, reset_time;

-- ---------------------------------------------------------------------------
-- TTL sweep
-- ---------------------------------------------------------------------------
--
-- Replaces the native Firestore TTL policies on `idempotency_keys.expiresAt`
-- and `rate_limits.expiresAt`. Postgres has no equivalent, so without this both
-- tables grow forever: one row per distinct (uid, idempotency-key) and one per
-- distinct client IP, never reclaimed.
--
-- ## Why this is a database function and not adapter code
--
-- The scheduler changes during the migration (Cloud Run now, a Worker cron
-- later) but the statement does not. Keeping the logic here means the caller is
-- always `select * from antiphony_sweep_expired();` — one statement, no query
-- building in an adapter, versioned alongside the tables it sweeps, and
-- runnable by hand from psql when something looks wrong.
--
-- ## Why NOT pg_cron
--
-- Neon supports pg_cron, and it looks like the obvious fit — until scale to
-- zero. Neon's own guidance is to use pg_cron "only on computes that run 24/7
-- or where you have disabled scale to zero", because jobs fire only while the
-- compute is active. A beta service with one operator is idle almost all the
-- time, and idle is exactly when scale to zero should be on. pg_cron here would
-- run rarely and unpredictably — which is the same silent, slow failure this
-- sweep exists to prevent, just relocated inside the database.
--
-- So the trigger lives OUTSIDE the database, where it fires regardless of
-- compute state, and waking Neon is a feature rather than a precondition.
--
-- ## THE SWEEP IS PURE SPACE RECLAMATION — it cannot corrupt anything
--
-- This is the property that makes the scheduling question low-stakes, and it is
-- worth being explicit about. Both upserts already treat an expired row as
-- absent: `idempotency_keys` reclaims one in place (`where expires_at < now()`)
-- and `rate_limits` resets the window. Deleting an expired row therefore
-- produces behaviour identical to leaving it. The sweep may run late, run
-- partially, skip rows, or not run for a week, and nothing observable changes
-- except disk.
--
-- That is why no interim scheduler is proposed for the Cloud Run window: at
-- beta volume the tables accrue a trivial number of rows between now and the
-- Worker, and a Cloud Scheduler job built to live three weeks is not worth its
-- own failure modes. Run it by hand if it ever looks large:
--
--     select * from antiphony_sweep_expired();
--
-- ## What is deliberately NOT swept
--
-- `posts.lease_until`. An expired lease needs no cleanup — the claim statement
-- treats it as claimable, which is the documented design in
-- ports/audio-processing-dependencies.ts ("An expired lease is claimable").
-- Deleting or nulling it would be busywork at best and would race the claim at
-- worst.

create function antiphony_sweep_expired(batch_size integer default 5000)
returns table (swept_table text, deleted bigint)
language plpgsql
as $$
declare
    n bigint;
begin
    -- Bounded per call rather than "delete everything expired". An unbounded
    -- delete holds locks and builds a WAL burst proportional to whatever
    -- accumulated, which is precisely the situation after the sweep has been
    -- broken for a while — i.e. it fails hardest exactly when it is needed
    -- most. The caller re-invokes while a count comes back equal to
    -- batch_size.
    --
    -- FOR UPDATE SKIP LOCKED so two overlapping sweeps (a retry, an operator
    -- running it by hand during a cron tick) divide the work instead of
    -- blocking on each other.

    delete from idempotency_keys
     where id in (
         select id
           from idempotency_keys
          where expires_at < now()
          order by expires_at
          limit batch_size
            for update skip locked
     );
    get diagnostics n = row_count;
    swept_table := 'idempotency_keys';
    deleted := n;
    return next;

    delete from rate_limits
     where key in (
         select key
           from rate_limits
          where expires_at < now()
          order by expires_at
          limit batch_size
            for update skip locked
     );
    get diagnostics n = row_count;
    swept_table := 'rate_limits';
    deleted := n;
    return next;
end;
$$;

comment on function antiphony_sweep_expired(integer) is
    'Reclaims expired idempotency keys and rate-limit buckets. Bounded per call; '
    're-invoke while a returned count equals batch_size. Pure space reclamation — '
    'safe to run late, partially, or not at all. Replaces Firestore native TTL.';

commit;

-- ---------------------------------------------------------------------------
-- Scheduling the sweep
-- ---------------------------------------------------------------------------
--
-- At step 3, the Worker gains a Cron Trigger. In wrangler config:
--
--     [triggers]
--     crons = ["17 * * * *"]      # hourly, off the hour
--
-- Off-the-hour deliberately: :00 is the busiest minute on Cloudflare's cron
-- scheduler, and this job has no reason to compete for it.
--
-- The handler is a drain loop with a hard cap, so a backlog cannot run the
-- Worker into its 15-minute scheduled-invocation ceiling:
--
--     export default {
--         async scheduled(_event, env, ctx) {
--             ctx.waitUntil((async () => {
--                 const BATCH = 5000;
--                 for (let pass = 0; pass < 20; pass++) {
--                     const rows = await sql`select * from antiphony_sweep_expired(${BATCH})`;
--                     const max = Math.max(...rows.map((r) => Number(r.deleted)));
--                     if (max < BATCH) return;        // drained
--                 }
--                 // Hit the cap with work left. Not an error — the next tick
--                 // continues — but it means the backlog is growing faster than
--                 // an hourly drain, which is worth a log line someone sees.
--                 console.warn('[ttl-sweep] cap reached with rows remaining');
--             })());
--         },
--     };
--
-- Hourly is arbitrary but defensible: the shorter TTL of the two is the
-- rate-limit window (minutes to an hour), so hourly keeps `rate_limits` within
-- roughly one window of its true size, and `idempotency_keys` (24h TTL) is
-- swept far more often than it needs.
--
-- ⚠️ Once `rate_limits` moves to a Durable Object (see the table's own note),
-- half this sweep becomes dead and should be deleted with it. A sweep quietly
-- deleting zero rows from a table nothing writes is the kind of thing that
-- survives for years.

-- ---------------------------------------------------------------------------
-- No table for renditions — deliberately
-- ---------------------------------------------------------------------------
--
-- Renditions resolve at `renditions/{originAppId}/{sourceCid}.{format}`, which
-- is derivable from the request alone. Existence is an R2 HEAD, so the cache
-- needs no rows, no lookup, and no row to fall out of sync with the object.
-- This is the reason renditions are addressed by derivation rather than
-- content — see specs/cloudflare-migration.md § Where renditions live.

-- ---------------------------------------------------------------------------
-- § Open
-- ---------------------------------------------------------------------------
--
-- 1. ~~TTL has no owner.~~ RESOLVED — see § TTL sweep above.
--    `antiphony_sweep_expired()` ships with this schema; a Cloudflare Cron
--    Trigger drives it from step 3. Not pg_cron: Neon only runs it while the
--    compute is awake, and scale to zero is wanted here. No interim scheduler
--    for the Cloud Run window — the sweep is pure space reclamation and beta
--    volume is trivial; run it by hand if it ever looks large.
--
-- 2. `FirestoreTimestampSchema` needs renaming. It already accepts ISO strings
--    and transforms to `Date`, so jsonb round-trips work unchanged — but the
--    name stops being true the moment Firestore is gone. Behavioural no-op.
--
-- 3. Verify CID round-trip stability before trusting the jsonb column. DAG-CBOR
--    canonicalises key order, so jsonb reordering is safe in theory. Numeric
--    coercion is the real risk (jsonb numbers are `numeric`, wider than JS).
--    The adapter suite wants a property test:
--        cidForRecord(read(write(record))) === record.cid
--
-- 4. `posts.record` still contains `processing` in the Zod type but not in this
--    column. The adapter must strip on write and reassemble on read BEFORE
--    `safeParse`, or the refine in AudioPostRecordSchema sees a record it does
--    not expect. Worth a dedicated test.
