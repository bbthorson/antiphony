-- Space URIs move to the `at:space/` form (specs/spaces-beta-readiness.md).
--
-- The atproto Spaces alpha of 2026-11-24 changed every space URI:
--
--     at://{spaceDid}/space/{spaceType}/{skey}[/{authorDid}/{collection}/{rkey}]   before
--     at:space/{spaceDid}/{spaceType}/{skey}[/{authorDid}/{collection}/{rkey}]     after
--
-- Public URIs (`at://{did}/{collection}/{rkey}`) are unchanged, and nothing
-- here touches one: every rewrite below matches only the old space form, so
-- running it again changes nothing.
--
-- Two kinds of stored URI, handled two ways:
--
--  1. Columns Antiphony writes itself (the deletion ledgers, a remote post's
--     key). These are rewritten in place.
--
--  2. Columns generated from a record value: a reply's StrongRefs and an
--     enrichment record's `subject`. The record can't be rewritten, because
--     its CID is computed over it and already sealed into other records'
--     StrongRefs. So the generated column normalizes instead: the record keeps
--     what was written, and the index holds the current form, which is what
--     every lookup now passes. The services normalize the same values when
--     they read them out of a record (`@antiphony/core/services/space-uri`).
--
-- `regexp_replace` is immutable, so it is allowed in a generated column.
-- `set expression` (Postgres 17+) rewrites the table and its indexes.

-- 1. Columns Antiphony writes. The shape check admits the new form first.

alter table remote_posts drop constraint remote_posts_uri_shape;
alter table remote_posts
    add constraint remote_posts_uri_shape check (uri like 'at://%' or uri like 'at:space/%');

update deleted_posts
   set uri = regexp_replace(uri, '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
 where uri ~ '^at://did:[a-z]+:[^/]+/space/';

update remote_posts
   set uri = regexp_replace(uri, '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
 where uri ~ '^at://did:[a-z]+:[^/]+/space/';

update deleted_remote_posts
   set uri = regexp_replace(uri, '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
 where uri ~ '^at://did:[a-z]+:[^/]+/space/';

-- 2. Columns generated from record values.

alter table posts
    alter column reply_parent_uri set expression as (
        regexp_replace(record -> 'reply' -> 'parent' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    ),
    alter column reply_root_uri set expression as (
        regexp_replace(record -> 'reply' -> 'root' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    );

alter table remote_posts
    alter column reply_parent_uri set expression as (
        regexp_replace(record -> 'reply' -> 'parent' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    ),
    alter column reply_root_uri set expression as (
        regexp_replace(record -> 'reply' -> 'root' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    );

alter table audio_transcripts
    alter column subject_uri set expression as (
        regexp_replace(record -> 'subject' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    );

alter table audio_assessments
    alter column subject_uri set expression as (
        regexp_replace(record -> 'subject' ->> 'uri', '^at://(did:[a-z]+:[^/]+)/space/', 'at:space/\1/')
    );
