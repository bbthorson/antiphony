-- ---------------------------------------------------------------------------
-- 0011_audio_assessments.sql
--
-- Platform-enrichment table for `dev.antiphony.audio.assessment` records
-- (specs/assess-stage.md §6). Mirrors `audio_transcripts`: last-write-wins
-- per (origin_app_id, subject_uri), so a recomputed pass replaces the prior
-- assessment cleanly and one tenant never sees another's.
-- ---------------------------------------------------------------------------

create table audio_assessments (
    id            text        primary key,
    origin_app_id text        not null,
    record        jsonb       not null,
    created_at    timestamptz not null,

    subject_uri   text        not null generated always as (record -> 'subject' ->> 'uri') stored,
    subject_cid   text        generated always as (record -> 'subject' ->> 'cid') stored,

    constraint assessments_created_at_matches_record check (
        created_at = (record ->> 'createdAt')::timestamptz
    )
);

create unique index assessments_tenant_subject_key
    on audio_assessments (origin_app_id, subject_uri);
