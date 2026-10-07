-- ---------------------------------------------------------------------------
-- atproto spaces, Phase 1 (specs/spaces.md): the data model.
--
-- A space is the triple (authority DID, space type NSID, skey). The authority is
-- always the calling tenant's own pinned DID, looked up through `getAppDid` as for
-- flat posts, so it is not stored: a space here is keyed by the tenant instead.
--
-- A post is either FLAT (`at://{appDid}/{collection}/{rkey}`, public) or PLACED
-- in a space (`at://{appDid}/space/{type}/{skey}/{authorSegment}/{collection}/{rkey}`).
-- Its visibility is its space's read policy, not a field on the post.
-- ---------------------------------------------------------------------------

create table spaces (
    -- The tenant whose DID is the space's authority. Leads the key, as
    -- `origin_app_id` leads every posts index, for the same isolation reason.
    origin_app_id          text        not null,

    -- An NSID (e.g. `game.bardcast.space.campaign`), validated by the service
    -- with @atproto/syntax before it reaches here.
    space_type             text        not null,

    -- atproto record-key syntax. A DID is a valid skey (colons are allowed),
    -- which is how a per-player space is keyed.
    skey                   text        not null,

    -- The two policies the protocol split `policy` into on 2026-09-18. Both
    -- from the start, so that split never needs a migration of its own. The
    -- protocol's default is `member-list`.
    read_policy            text        not null default 'member-list',
    write_policy           text        not null default 'member-list',

    -- Where `checkUserAccess` is called for `managing-app` policies. Nullable:
    -- the tenant is its own managing app, and tenant reads need no callback
    -- (Phase 2). Only Phase 3's protocol surface, serving apps OTHER than the
    -- tenant, needs it set.
    managing_app_endpoint  text,

    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),

    primary key (origin_app_id, space_type, skey),

    constraint spaces_read_policy_valid
        check (read_policy in ('public', 'member-list', 'managing-app')),
    constraint spaces_write_policy_valid
        check (write_policy in ('public', 'member-list', 'managing-app'))
);

-- A post's placement lives in the record (`record -> 'space'`), like every other
-- storage field, and is promoted to generated columns here exactly as 0001's
-- query facets are. It is NOT in the record CID: placement is location, which
-- the protocol carries in the URI (specs/spaces.md, "Space placement is out of
-- the CID").
alter table posts
    add column space_type     text generated always as (record -> 'space' ->> 'type') stored,
    add column skey           text generated always as (record -> 'space' ->> 'skey') stored,
    add column author_segment text generated always as (record -> 'space' ->> 'authorSegment') stored;

-- All three or none: a half-placed post would have no well-formed URI.
alter table posts
    add constraint posts_space_all_or_none check (
        (space_type is null     and skey is null     and author_segment is null)
     or (space_type is not null and skey is not null and author_segment is not null)
    );

-- A placed post's space must exist, in the same tenant. With MATCH SIMPLE (the
-- default) a flat post, whose space columns are all null, is not checked. The
-- default NO ACTION also refuses to delete a space that still holds posts,
-- which is right: a post's space is fixed at creation and sealed into every
-- reply's StrongRef.
alter table posts
    add constraint posts_space_exists
        foreign key (origin_app_id, space_type, skey)
        references spaces (origin_app_id, space_type, skey);

-- Listing a space's posts, newest first. Partial: only placed posts.
create index posts_space_created_idx
    on posts (origin_app_id, space_type, skey, created_at desc, id desc)
    where space_type is not null;
