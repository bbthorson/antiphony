/**
 * ProcessingDispatchPort — the portable contract for handing one post's audio
 * processing to whatever runs it. Concrete dispatchers live in the outbound
 * adapters, never in `@antiphony/core`.
 *
 * **Only the ENQUEUE side is a port.** The consume side is inbound and
 * genuinely platform-shaped — Cloud Tasks pushes HTTP at a worker route,
 * Cloudflare Queues invokes a `queue()` handler over a batch — and both are
 * thin wrappers around `AudioProcessingService.process(originAppId, postId)`,
 * which already takes exactly this job. Abstracting the consumer as well would
 * invent a uniformity that isn't there.
 *
 * **Narrow rather than a generic queue.** There is one job type. A
 * `QueuePort<T>` with an opaque payload would push the payload's schema
 * decision out to every call site and give up the compile-time check the other
 * ports here rely on. Cloud Tasks and Cloudflare Queues both sit behind this
 * interface unchanged; their differences are entirely adapter-side, which is
 * the property the migration actually needs.
 */

/**
 * The job payload: the two identifiers and deliberately nothing else.
 *
 * **No stage list.** The post's stored `processing` state is authoritative,
 * and a PATCH landing between dispatch and execution has to win. Re-reading
 * state at execution time is what makes redelivery and out-of-order delivery
 * self-healing; a payload carrying its own stage list would run a plan the
 * caller has already replaced.
 *
 * `originAppId` is part of the job, not ambient: the worker runs outside the
 * originating request, so there is no tenant context to inherit and every
 * storage read is tenant-scoped.
 */
export interface ProcessingJob {
    originAppId: string;
    postId: string;
}

export interface ProcessingDispatchPort {
    /**
     * Hand off one post's processing. Resolves once the job is DURABLE (in the
     * queue), not once it has run — except for the inline dispatcher, which
     * runs it synchronously by construction.
     *
     * **May reject.** Enqueue is network I/O against a queue service and can
     * fail. The caller has already committed the post by this point and must
     * not fail the response over it, so the dispatch site is responsible for
     * catching; this contract does not swallow, because a dispatcher that
     * silently absorbed its own failures would be indistinguishable from one
     * that worked.
     */
    dispatch(job: ProcessingJob): Promise<void>;
}
