import type { PostStats } from 'shared/types/stats';

/**
 * Where the window edges are, as the service fixed them for one read: a row is
 * in the 24 hour window when its `createdAt` is at or after `since24h`, and in
 * the 7 day window when it is at or after `since7d`.
 */
export interface StatsWindowEdges {
    since24h: Date;
    since7d: Date;
}

/**
 * Counts for one tenant (specs/tenancy-stats.md).
 *
 * Count-shaped on purpose: this port returns numbers and has no way to return a
 * row. A tenancy-wide list would reopen the enumeration surface the core
 * surface closed, for a question that only needs a figure.
 */
export interface TenantStatsDependencies {
    /**
     * Hosted posts and registered remote posts of `originAppId`, all counted in
     * one read so that `prompts + replies = posts` holds in every figure returned
     * and no figure counts a row another does not. A tenant with no rows gets
     * zeros.
     */
    countTenantPosts(
        originAppId: string,
        edges: StatsWindowEdges,
    ): Promise<{ posts: PostStats; remotePosts: PostStats }>;
}
