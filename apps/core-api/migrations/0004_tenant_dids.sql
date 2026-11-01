-- ---------------------------------------------------------------------------
-- More than one DID per tenant (specs/did-plc-and-multi-did-tenancy.md §3,
-- revised by specs/audio-service-and-groups.md).
--
-- Until now a tenant wrote under exactly one DID: its app DID, pinned in
-- ANTIPHONY_APP_DIDS. A tenant also acts for groups (a Bardcast table, a Vox Pop
-- org), each with a DID of its own that some group host created. This table
-- records which tenant may write under which of those DIDs.
--
-- The app DID itself stays in ANTIPHONY_APP_DIDS for now: it is checked at the
-- auth boundary on every request and seeded from config, and moving it here is a
-- separate change.
--
-- A row is written only after the DID's document was resolved and named this
-- deployment as its space host (the same custody check the app DID passes), so a
-- tenant can't register a DID that doesn't point at us.
-- ---------------------------------------------------------------------------

create table tenant_dids (
    -- The primary key on purpose: a DID belongs to at most one tenant, so
    -- tenant A can never register, and later write under, a DID tenant B holds.
    did            text        primary key,
    origin_app_id  text        not null,
    -- What the DID is to the tenant. Only groups today; Antiphony never holds a
    -- person's DID as an authority (a person's DID names their own PDS).
    role           text        not null,
    -- The tenant's own id for the group (a campaign table id, an org id).
    -- Opaque to Antiphony.
    subject_ref    text,
    created_at     timestamptz not null default now(),

    constraint tenant_dids_role_valid check (role in ('group')),
    constraint tenant_dids_did_shape check (did like 'did:%:%'),
    constraint tenant_dids_subject_ref_bounded check (subject_ref is null or length(subject_ref) <= 256)
);

-- Listing a tenant's DIDs, newest first, paged by (created_at, did).
create index tenant_dids_by_tenant on tenant_dids (origin_app_id, created_at desc, did desc);
