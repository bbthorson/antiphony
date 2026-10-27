/**
 * DeletionNotifierPort — tells the tenant a post was deleted, over the same
 * per-tenant webhook as stage events (`specs/deletion.md` § 8,
 * `specs/enrichment-webhooks.md`).
 *
 * Best-effort, like `ProcessingNotifierPort`: the delete route's own response
 * is the authoritative record of what it removed, so a dropped event costs a
 * receiver nothing it could not read from that response. Fired only after the
 * deleting statement has committed.
 */

export interface PostDeletedEvent {
    originAppId: string;
    postId: string;
    /** The URI the post had, as kept in the deletion ledger. */
    uri: string;
    kind: 'prompt' | 'reply';
    /** Server time of the delete (ISO-8601). */
    occurredAt: string;
}

export interface DeletionNotifierPort {
    /** Announce one deleted post. May reject; the caller logs and swallows. */
    notifyDeleted(event: PostDeletedEvent): Promise<void>;
}

/** The do-nothing notifier, for deployments and tests with no webhook wired. */
export const noopDeletionNotifier: DeletionNotifierPort = {
    async notifyDeleted(): Promise<void> {},
};
