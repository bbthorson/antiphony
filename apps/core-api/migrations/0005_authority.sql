-- ---------------------------------------------------------------------------
-- Posts and spaces under a DID other than the tenant's app DID
-- (specs/did-plc-and-multi-did-tenancy.md §3, step B).
--
-- A tenant may now write under a DID it registered in `tenant_dids` (0004),
-- such as a group's. A space is the triple (authority, type, skey), so two
-- groups can each have a campaign called "x", and the authority joins the key.
--
-- The app DID is still never stored: it lives in ANTIPHONY_APP_DIDS. So
-- "the app DID" is written as:
--   - posts: no `authority` in the record (as every post before this);
--   - spaces: authority = '' (a primary key can't hold a null).
-- Any other value must be a DID registered to the same tenant, which the
-- foreign keys to `tenant_dids` enforce. They also refuse to unregister a DID
-- while any post or space is still under it.
-- ---------------------------------------------------------------------------

-- The composite target the foreign keys below need: a DID together with the
-- tenant that registered it. `did` alone is already unique.
alter table tenant_dids
    add constraint tenant_dids_did_tenant unique (did, origin_app_id);

-- --- spaces -----------------------------------------------------------------

alter table spaces
    add column authority text not null default '';

-- The same value as a nullable DID, so the foreign key below skips the app
-- DID's '' (MATCH SIMPLE ignores a row with any null column).
alter table spaces
    add column authority_did text generated always as (nullif(authority, '')) stored;

-- posts_space_exists depends on the old primary key; it is re-made below.
alter table posts drop constraint posts_space_exists;
alter table spaces drop constraint spaces_pkey;
alter table spaces add primary key (origin_app_id, authority, space_type, skey);

alter table spaces
    add constraint spaces_authority_registered
        foreign key (authority_did, origin_app_id)
        references tenant_dids (did, origin_app_id);

-- --- posts ------------------------------------------------------------------

-- The post's authority when it isn't the app DID. Promoted from the record,
-- like every other storage field; not in the record CID.
alter table posts
    add column authority text generated always as (record ->> 'authority') stored;

-- The authority as the spaces table writes it, for a placed post only, so the
-- foreign key to its space can match '' for the app DID. Null for a flat post,
-- which MATCH SIMPLE then leaves unchecked, as before.
alter table posts
    add column space_authority text generated always as (
        case when record -> 'space' ->> 'type' is null then null
             else coalesce(record ->> 'authority', '')
        end
    ) stored;

-- A placed post's space must exist under the post's own authority, in the same
-- tenant. Still refuses to delete a space that holds posts.
alter table posts
    add constraint posts_space_exists
        foreign key (origin_app_id, space_authority, space_type, skey)
        references spaces (origin_app_id, authority, space_type, skey);

-- A post under another DID needs that DID registered to its tenant.
alter table posts
    add constraint posts_authority_registered
        foreign key (authority, origin_app_id)
        references tenant_dids (did, origin_app_id);

-- Listing a space's posts now names the authority too.
drop index posts_space_created_idx;
create index posts_space_created_idx
    on posts (origin_app_id, space_authority, space_type, skey, created_at desc, id desc)
    where space_type is not null;

-- Backs the foreign key's check when a registration is deleted (unregistering),
-- which would otherwise scan every post.
create index posts_authority_idx
    on posts (authority, origin_app_id)
    where authority is not null;
