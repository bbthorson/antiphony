import type { TenantStats } from 'shared/types/stats';
import type { TenantStatsDependencies } from '../ports/tenant-stats-dependencies';

const HOUR_MS = 60 * 60 * 1000;

/** The two fixed windows. A `since` parameter is a later, additive change if a caller needs one. */
export const STATS_WINDOW_MS = { last24h: 24 * HOUR_MS, last7d: 7 * 24 * HOUR_MS } as const;

/**
 * TenantStatsService: how many posts the calling tenant has, in total and over
 * the last day and week (specs/tenancy-stats.md).
 *
 * The service owns the one decision that has to be shared by every figure: the
 * read time. It takes the clock once, derives both window edges from it, and
 * reports it as `asOf`, so the answer says exactly which instant it describes.
 * Counting is the port's job.
 */
export class TenantStatsService {
    constructor(
        private readonly deps: TenantStatsDependencies,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async getStats(originAppId: string): Promise<TenantStats> {
        const asOf = this.now();
        const counts = await this.deps.countTenantPosts(originAppId, {
            since24h: new Date(asOf.getTime() - STATS_WINDOW_MS.last24h),
            since7d: new Date(asOf.getTime() - STATS_WINDOW_MS.last7d),
        });
        return { ...counts, asOf: asOf.toISOString() };
    }
}
