import { z } from 'zod';

/**
 * **Tenancy stats** (specs/tenancy-stats.md): corpus-level counts for the
 * calling tenant, answered by `dev.antiphony.tenant.getStats`.
 *
 * Counts only. There is no per-author figure, no date-range parameter and no
 * other tenant's number anywhere in this shape, on purpose: the spec's scope
 * guard keeps Antiphony's zero-user-data line, and a stats method that grew
 * those would become an analytics API.
 */

/** Posts, prompts and replies over one set of rows. `posts` is `prompts + replies`. */
export const StatCountsSchema = z.object({
    posts: z.number().int().min(0),
    prompts: z.number().int().min(0),
    replies: z.number().int().min(0),
});
export type StatCounts = z.infer<typeof StatCountsSchema>;

/** The two fixed windows, counted back from `asOf` by `createdAt`. */
export const StatWindowsSchema = z.object({
    last24h: StatCountsSchema,
    last7d: StatCountsSchema,
});
export type StatWindows = z.infer<typeof StatWindowsSchema>;

/** Counts over one table: every row, and the rows inside each window. */
export const PostStatsSchema = z.object({
    totals: StatCountsSchema,
    windows: StatWindowsSchema,
});
export type PostStats = z.infer<typeof PostStatsSchema>;

/**
 * What `getStats` answers. `posts` counts hosted posts, `remotePosts` the
 * remote posts the tenant registered; the two never overlap. `asOf` is the one
 * read time every number was taken at, so a cached copy can say how old it is.
 */
export const TenantStatsSchema = z.object({
    posts: PostStatsSchema,
    remotePosts: PostStatsSchema,
    asOf: z.iso.datetime(),
});
export type TenantStats = z.infer<typeof TenantStatsSchema>;
