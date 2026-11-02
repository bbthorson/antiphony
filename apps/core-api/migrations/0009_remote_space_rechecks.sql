-- ---------------------------------------------------------------------------
-- Rechecking space records (specs/audio-service-mode.md, Phase C).
--
-- From Phase C a space record can be `fetched` too: Antiphony read it on a
-- member's delegation. So "the rows the hourly sweep reads itself" is no
-- longer `verified = 'fetched'` (0008's index) but "repo records": a space
-- record takes a fresh delegation to read, which the tenant supplies through
-- a recheck call per space. Two indexes, one for each:
--   - the sweep over repo records, least recently checked first;
--   - a space's rows, least recently checked first, for a recheck call and
--     for finding which spaces are due.
-- ---------------------------------------------------------------------------

create index remote_posts_repo_sweep_idx on remote_posts (checked_at) where space is null;
drop index remote_posts_sweep_idx;

create index remote_posts_space_checked_idx
    on remote_posts (origin_app_id, (space ->> 'authority'), (space ->> 'type'), (space ->> 'skey'), checked_at)
    where space is not null;
