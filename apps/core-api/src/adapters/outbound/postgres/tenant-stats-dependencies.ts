import type { PostStats, StatCounts } from 'shared/types/stats';
import type { TenantStatsDependencies } from '@antiphony/core/ports/tenant-stats-dependencies';
import type { SqlClient } from '../../../ports/sql-client.js';

/**
 * Postgres `TenantStatsDependencies` over `posts` and `remote_posts`.
 *
 * Every figure comes from one statement, so they share one snapshot: no row can
 * appear in one count and not in another, and `prompts + replies = posts` holds
 * in each. (`SqlClient` has no interactive transaction, and none is needed: a
 * single statement reads a single snapshot.) Everything is scoped by
 * `origin_app_id`, and the statement returns scalars only.
 *
 * Which indexes serve it, so that nobody adds one for it (migration 0011 was
 * considered and not written; specs/tenancy-stats.md § 4.2). Checked with
 * EXPLAIN over 30,000 posts and 20,000 remote posts per tenant, two tenants:
 *   - hosted posts are one index-only pass over `posts_author_kind_created_idx`
 *     (origin_app_id, author_id, kind, created_at, ...), which holds every
 *     column the counts read, so the table rows are never touched. The window
 *     counts ride along in that pass, and a pass over the tenant is what the
 *     totals need whatever the indexes are, so a (origin_app_id, created_at)
 *     index would buy the windows nothing while the totals are counted too;
 *   - each remote post count is an index-only scan that starts at the tenant's
 *     entries: the windows range on `created_at` through the indexes 0010 added,
 *     and the reply counts read the partial `remote_posts_reply_root_idx`, which
 *     holds replies only.
 * None of the plans reads a table row or scans the table.
 *
 * A window is by the row's `created_at`, as the spec has it: for a hosted post
 * the time it was posted, for a remote post the `createdAt` its record claims,
 * which is not when it was registered here.
 */

interface StatsRow {
    // `count(*)` is a bigint, which drivers return as a string, a number or a bigint.
    h_prompts: string | number | bigint;
    h_replies: string | number | bigint;
    h_prompts_24h: string | number | bigint;
    h_replies_24h: string | number | bigint;
    h_prompts_7d: string | number | bigint;
    h_replies_7d: string | number | bigint;
    r_posts: string | number | bigint;
    r_replies: string | number | bigint;
    r_posts_24h: string | number | bigint;
    r_replies_24h: string | number | bigint;
    r_posts_7d: string | number | bigint;
    r_replies_7d: string | number | bigint;
}

/** Counts from a prompt figure and a reply figure. */
const fromSplit = (prompts: StatsRow[keyof StatsRow], replies: StatsRow[keyof StatsRow]): StatCounts => ({
    posts: Number(prompts) + Number(replies),
    prompts: Number(prompts),
    replies: Number(replies),
});

/** Counts from an all-rows figure and a reply figure: the rest are prompts. */
const fromTotal = (posts: StatsRow[keyof StatsRow], replies: StatsRow[keyof StatsRow]): StatCounts => ({
    posts: Number(posts),
    prompts: Number(posts) - Number(replies),
    replies: Number(replies),
});

export function postgresTenantStatsDependencies(sql: SqlClient): TenantStatsDependencies {
    return {
        async countTenantPosts(originAppId, { since24h, since7d }) {
            const [row] = await sql.query<StatsRow>(
                `
                select
                    h.prompts       as h_prompts,
                    h.replies       as h_replies,
                    h.prompts_24h   as h_prompts_24h,
                    h.replies_24h   as h_replies_24h,
                    h.prompts_7d    as h_prompts_7d,
                    h.replies_7d    as h_replies_7d,
                    (select count(*) from remote_posts
                      where origin_app_id = $1)                                           as r_posts,
                    (select count(*) from remote_posts
                      where origin_app_id = $1 and reply_root_uri is not null)            as r_replies,
                    (select count(*) from remote_posts
                      where origin_app_id = $1 and created_at >= $2::timestamptz)         as r_posts_24h,
                    (select count(*) from remote_posts
                      where origin_app_id = $1 and reply_root_uri is not null
                        and created_at >= $2::timestamptz)                                as r_replies_24h,
                    (select count(*) from remote_posts
                      where origin_app_id = $1 and created_at >= $3::timestamptz)         as r_posts_7d,
                    (select count(*) from remote_posts
                      where origin_app_id = $1 and reply_root_uri is not null
                        and created_at >= $3::timestamptz)                                as r_replies_7d
                  from (
                    select
                        count(*) filter (where kind = 'prompt')                                      as prompts,
                        count(*) filter (where kind = 'reply')                                       as replies,
                        count(*) filter (where kind = 'prompt' and created_at >= $2::timestamptz)    as prompts_24h,
                        count(*) filter (where kind = 'reply'  and created_at >= $2::timestamptz)    as replies_24h,
                        count(*) filter (where kind = 'prompt' and created_at >= $3::timestamptz)    as prompts_7d,
                        count(*) filter (where kind = 'reply'  and created_at >= $3::timestamptz)    as replies_7d
                      from posts
                     where origin_app_id = $1
                  ) h
                `,
                [originAppId, since24h, since7d],
            );
            // An aggregate with no GROUP BY always returns a row; this is for the type.
            if (!row) throw new Error('[postgres] tenant stats statement returned no row');

            const posts: PostStats = {
                totals: fromSplit(row.h_prompts, row.h_replies),
                windows: {
                    last24h: fromSplit(row.h_prompts_24h, row.h_replies_24h),
                    last7d: fromSplit(row.h_prompts_7d, row.h_replies_7d),
                },
            };
            const remotePosts: PostStats = {
                totals: fromTotal(row.r_posts, row.r_replies),
                windows: {
                    last24h: fromTotal(row.r_posts_24h, row.r_replies_24h),
                    last7d: fromTotal(row.r_posts_7d, row.r_replies_7d),
                },
            };
            return { posts, remotePosts };
        },
    };
}
