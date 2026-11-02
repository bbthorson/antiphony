-- ---------------------------------------------------------------------------
-- Transcripts: the contract half of the tenant key (specs/audio-service-mode.md
-- §6; the expand half is 0006).
--
-- 0006 added `audio_transcripts.origin_app_id` and a unique index on
-- (origin_app_id, subject_uri), and kept the old unique index on subject_uri
-- alone, because the Worker still serving while 0006 ran upserted
-- `on conflict (subject_uri)`, which needs it. Every Worker since 0006 upserts
-- `on conflict (origin_app_id, subject_uri)`, so the old index now only stops
-- two tenants from each holding a transcript of the same remote URI.
--
-- Apply only once a Worker built from 0006's code is live: the deploy runs
-- migrations BEFORE it ships the new Worker, so this must not land in the same
-- deploy as 0006.
-- ---------------------------------------------------------------------------

drop index transcripts_subject_uri_key;
