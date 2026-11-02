-- ---------------------------------------------------------------------------
-- Remote posts in spaces (specs/audio-service-mode.md, Phase B).
--
-- A space record lives in a space Antiphony can't read: the member's own PDS,
-- or the group's repo on its group host. Until Antiphony can obtain a space
-- credential itself (Phase C), the tenant pushes the record body and the bytes
-- it read, and Antiphony checks they hash to the registered CID and blob ref.
-- So a row now says where its record is (`space`) and how it was checked
-- (`verified`), the two §5.2 columns 0006 left for this phase.
--
-- `repo_did` (0006) is already the DID whose repo holds the record. For a space
-- record that is the URI's author segment, not its authority.
-- ---------------------------------------------------------------------------

alter table remote_posts
    -- The space the record is in, `{ authority, type, skey }`; null for a plain
    -- repo record. The authority is a group's DID, which is never in
    -- `tenant_dids` (#227), so there is no foreign key to have.
    add column space    jsonb,
    -- `fetched`: Antiphony read the record and its blob from the source itself.
    -- `pushed`: the tenant sent them (Phase B), which proves content, not
    -- access. Every existing row was fetched.
    add column verified text not null default 'fetched',

    add constraint remote_posts_verified_valid check (verified in ('fetched', 'pushed')),
    add constraint remote_posts_space_shape check (
        space is null or (
            jsonb_typeof(space) = 'object'
            and coalesce(space ->> 'authority', '') like 'did:%'
            and coalesce(space ->> 'type', '') <> ''
            and coalesce(space ->> 'skey', '') <> ''
        )
    ),
    -- A pushed record is only ever a space record: a plain repo record is
    -- public, so Antiphony reads it itself.
    add constraint remote_posts_pushed_is_space check (verified = 'fetched' or space is not null);

-- The sweep rechecks only what it can read (§8.1). A pushed space record can't
-- be read before Phase C, so the tenant's DELETE is its only signal, and the
-- sweep's index leaves it out. Replaces 0006's index on every row.
create index remote_posts_sweep_idx on remote_posts (checked_at) where verified = 'fetched';
drop index remote_posts_checked_idx;
