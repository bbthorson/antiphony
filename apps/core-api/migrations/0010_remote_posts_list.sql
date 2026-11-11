-- ---------------------------------------------------------------------------
-- Listing a tenant's remote posts (dev.antiphony.audio.listRemotePosts).
--
-- The listing is newest first on (created_at, uri), for a whole tenant or for
-- one repo's records. Until now the only read by anything but the URI was a
-- thread's (0006's reply-root index), so a tenant-wide page would have sorted
-- every row the tenant has. Two indexes:
--   - the tenant's rows in listing order;
--   - one repo's rows in listing order, for `repo=`.
-- A listing filtered to one space walks 0009's per-space index and sorts that
-- space's rows, which is one prompt's replies for the apps that use it.
-- ---------------------------------------------------------------------------

create index remote_posts_list_idx on remote_posts (origin_app_id, created_at desc, uri desc);

create index remote_posts_repo_list_idx on remote_posts (origin_app_id, repo_did, created_at desc, uri desc);
