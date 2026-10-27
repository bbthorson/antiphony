-- ---------------------------------------------------------------------------
-- Deleting posts and their audio (specs/deletion.md).
--
-- A delete is a hard delete: the post row, its transcript and every blob only it
-- used are removed. What survives is a ledger row with no content in it, and a
-- queue of blob CIDs still to be removed from R2.
--
-- The SQL client runs one statement at a time over HTTP and cannot hold a
-- transaction open (ports/sql-client.ts), so the delete is ONE statement whose
-- data-modifying CTEs write all of this together. The tables below are shaped so
-- that statement can be written: the queue holds CIDs, not paths, and the
-- reference check reads indexed columns.
-- ---------------------------------------------------------------------------

-- The deletion ledger. One row per deleted post, kept indefinitely.
--
-- Deliberately content-free: the URI's segments are the authority's DID, the
-- collection, a space type and key, and a TID. No text, no audio or record CID,
-- no author, no actor. It is what makes a repeated delete answer "already
-- deleted", what lets a read tell a deleted post from a mistyped id (410 vs
-- 404), and the input a future sync surface turns into delete ops.
create table deleted_posts (
    origin_app_id  text        not null,
    post_id        text        not null,
    uri            text        not null,
    kind           text        not null,
    deleted_at     timestamptz not null default now(),

    primary key (origin_app_id, post_id),

    constraint deleted_posts_kind_valid check (kind in ('prompt', 'reply'))
);

-- Blob CIDs whose objects may need removing. Written in the same statement that
-- deletes the posts, so a crash between that statement and the R2 call leaves a
-- row saying what is still to do, rather than bytes nothing points at.
--
-- A CID here is a CANDIDATE: the drain re-checks, at drain time, whether any
-- remaining post in the tenant references it, and only deletes the objects when
-- none does. A post created between the enqueue and the drain keeps its audio.
create table blob_deletions (
    origin_app_id  text        not null,
    cid            text        not null,
    enqueued_at    timestamptz not null default now(),

    primary key (origin_app_id, cid)
);

create index blob_deletions_enqueued_idx on blob_deletions (enqueued_at);

-- The three ways a post references a blob, promoted so the drain's reference
-- check is indexed: the original audio (inside the record CID), the processed
-- variant, and every variant processing has written for the post. The first two
-- are generated columns like 0001's facets; the third is a jsonb array, indexed
-- with GIN for the `?` containment test.
--
-- Generated from `processing` as well as `record`: both are plain columns, and
-- `->>` is immutable.
alter table posts
    add column audio_cid          text generated always as (record -> 'embed' -> 'audio' -> 'ref' ->> '$link') stored,
    add column processed_blob_cid text generated always as (processing ->> 'processedBlobCid') stored;

create index posts_audio_cid_idx
    on posts (origin_app_id, audio_cid)
    where audio_cid is not null;

create index posts_processed_blob_cid_idx
    on posts (origin_app_id, processed_blob_cid)
    where processed_blob_cid is not null;

create index posts_derived_blob_cids_idx
    on posts using gin ((processing -> 'derivedBlobCids'));

-- Every reply carries its thread root's URI (`reply.root.uri`). A delete reads a
-- whole thread at once to find the subtree below a post, so it gets the same
-- treatment as `reply_parent_uri` in 0001: a generated column and a partial index
-- over replies only.
alter table posts
    add column reply_root_uri text generated always as (record -> 'reply' -> 'root' ->> 'uri') stored;

create index posts_reply_root_idx
    on posts (origin_app_id, reply_root_uri)
    where kind = 'reply';
