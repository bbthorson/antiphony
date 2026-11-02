-- ---------------------------------------------------------------------------
-- Remote posts: audio whose record lives in a repo Antiphony doesn't host
-- (specs/audio-service-mode.md, Phase A).
--
-- A tenant registers a record by URI and CID; Antiphony fetches the record
-- from the repo the URI names, copies its blob, processes it and serves it.
-- The record is never written here by Antiphony and its URI was minted
-- elsewhere, so this is a table of its own beside `posts` (D-5):
--   - `posts.id` is an rkey and its primary key, and two repos can share an
--     rkey, so a remote record is keyed by its full URI;
--   - a remote record's URI is a fact read from elsewhere, not computed;
--   - `posts` carries custody foreign keys (0005) a remote record must not need.
--
-- Phase A covers public repo records only. Space records (Phase B) add their
-- placement in a later migration.
-- ---------------------------------------------------------------------------

create table remote_posts (
    origin_app_id     text        not null,
    uri               text        not null,
    cid               text        not null,

    -- The DID whose repo holds the record, and the record's address in it.
    repo_did          text        not null,
    collection        text        not null,
    rkey              text        not null,

    -- The record as fetched and validated against dev.antiphony.audio.post.
    record            jsonb       not null,

    -- The blob ref, checked against the downloaded bytes.
    blob_cid          text        not null,
    mime_type         text        not null,
    size              bigint      not null,

    -- Whether the stored blob is private (signed playback only). A public
    -- record's blob is public, unless the same bytes were already stored as
    -- private by a hosted post in a space; Phase A never changes an existing
    -- object's visibility (specs/audio-service-mode.md §7, Phase B).
    blob_private      boolean     not null default false,

    -- Processing, exactly as on `posts`: the same state machine and lease.
    processing        jsonb,
    lease_until       timestamptz,

    -- The record's own `createdAt`, written by the adapter (the cast in a
    -- generated column would not be IMMUTABLE, as for posts.created_at).
    created_at        timestamptz not null,
    registered_at     timestamptz not null default now(),

    -- The deletion sweep (§8.1): when the source was last read, the first of
    -- two consecutive "gone" reads, and the start of an unreachable run.
    checked_at        timestamptz not null default now(),
    gone_at           timestamptz,
    unreachable_since timestamptz,

    reply_root_uri    text generated always as (record -> 'reply' -> 'root' ->> 'uri') stored,
    reply_parent_uri  text generated always as (record -> 'reply' -> 'parent' ->> 'uri') stored,
    processed_blob_cid text generated always as (processing ->> 'processedBlobCid') stored,

    primary key (origin_app_id, uri),

    constraint remote_posts_uri_shape check (uri like 'at://%'),
    constraint remote_posts_repo_did_shape check (repo_did like 'did:%'),
    constraint remote_posts_size_nonneg check (size >= 0)
);

-- Thread reads: every registered reply under one root, in created order.
create index remote_posts_reply_root_idx
    on remote_posts (origin_app_id, reply_root_uri, created_at)
    where reply_root_uri is not null;

-- The shared-blob check at drain time (specs/deletion.md § 6.2) must see a
-- blob a remote post references, as it sees the ones posts reference (0003).
create index remote_posts_blob_cid_idx
    on remote_posts (origin_app_id, blob_cid);
create index remote_posts_processed_blob_cid_idx
    on remote_posts (origin_app_id, processed_blob_cid)
    where processed_blob_cid is not null;
create index remote_posts_derived_blob_cids_idx
    on remote_posts using gin ((processing -> 'derivedBlobCids'));

-- The sweep reads the least recently checked rows first.
create index remote_posts_checked_idx on remote_posts (checked_at);

-- A content-free ledger of removed remote posts, as `deleted_posts` is for
-- hosted ones: the URI, when, and why. A read of a removed URI answers 410.
-- Re-registering the URI (the record still exists) clears its row.
create table deleted_remote_posts (
    origin_app_id  text        not null,
    uri            text        not null,
    reason         text        not null,
    deleted_at     timestamptz not null default now(),
    primary key (origin_app_id, uri),
    constraint deleted_remote_posts_reason_valid check (reason in ('tenant', 'gone'))
);

-- ---------------------------------------------------------------------------
-- Transcripts get a tenant (§6, the expand half).
--
-- `audio_transcripts` has no tenant column and is unique on `subject_uri`
-- alone. Hosted subjects never collided, since their URIs differ by authority,
-- but two tenants may register the same remote URI, and each gets its own
-- processing. So a transcript is keyed by (tenant, subject) from now on.
--
-- The old unique index stays for one deploy: the Worker serving while this
-- migration runs upserts `on conflict (subject_uri)`, which needs it. The next
-- migration drops it. Until then a second tenant can't hold a transcript of a
-- URI another tenant already transcribed.
-- ---------------------------------------------------------------------------

alter table audio_transcripts add column origin_app_id text;

-- Every existing transcript is of a hosted post, whose URI ends in its rkey,
-- which is `posts.id` and globally unique.
update audio_transcripts t
   set origin_app_id = p.origin_app_id
  from posts p
 where p.id = regexp_replace(t.subject_uri, '^.*/', '');

-- A transcript whose post is gone is unreachable (reads go through the post's
-- URI) and would block `not null`. Deletion removes them with their post
-- (0003); any left over predate that.
delete from audio_transcripts where origin_app_id is null;

alter table audio_transcripts alter column origin_app_id set not null;

create unique index transcripts_tenant_subject_uri_key
    on audio_transcripts (origin_app_id, subject_uri);
