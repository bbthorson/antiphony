import type { AudioPostRecord } from 'shared/types/audio';
import type {
    DeletedPostRef,
    DeletePostResult,
    EraseAuthorResult,
    KeptPostRef,
    RepliesPolicy,
} from 'shared/types/deletion';
import type { DeletedPostRecord, PostDeletionDependencies, PostToDelete } from '../ports/post-deletion-dependencies';
import { noopDeletionNotifier, type DeletionNotifierPort } from '../ports/deletion-notifier';
import { type Logger, defaultLogger } from '../ports/logger';
import { buildPostUri } from './audio-posts';

/**
 * PostDeletionService — hard deletes of posts and their audio
 * (specs/deletion.md).
 *
 * A delete removes the post, the replies its `replies` policy says to remove,
 * their transcripts and every blob no remaining post references, and leaves a
 * content-free ledger row per post. It is idempotent and resumable: a subtree
 * too large for one call is removed over several, deepest first, with the post
 * itself last, so a partial call never leaves a reply whose deletion was asked
 * for under a parent that is already gone.
 *
 * Authorization is not here. Tenancy comes from the caller's credential and
 * every dependency is scoped by it; who within the tenant may delete is the
 * tenant's decision (§ 5).
 */

/** Most posts one call removes. Bounds the call inside a Worker's CPU and subrequest limits. */
export const DELETION_PAGE_SIZE = 200;

/** Queued blob CIDs one call drains on its way out. The cron drains the rest. */
const DRAIN_BATCH = 500;

interface SubtreeOptions {
    replies: RepliesPolicy;
    /** Most posts to remove in this call. */
    budget: number;
    /** An author whose posts are always deleted, whatever `replies` says (author erasure). */
    eraseAuthorId?: string;
}

interface SubtreePage {
    /** True once the post itself is removed. */
    complete: boolean;
    /** Whether this call removed the post itself. */
    removedRoot: boolean;
    deleted: DeletedPostRef[];
    kept: KeptPostRef[];
}

export class PostDeletionService {
    constructor(
        private readonly deps: PostDeletionDependencies,
        private readonly notifier: DeletionNotifierPort = noopDeletionNotifier,
        private readonly logger: Logger = defaultLogger,
        private readonly pageSize: number = DELETION_PAGE_SIZE,
    ) {}

    /**
     * Delete one post and, per `replies`, the replies below it. Null when the
     * tenant has no such post and never had one (a 404); another tenant's post
     * reads the same way.
     */
    async deletePost(originAppId: string, postId: string, replies: RepliesPolicy): Promise<DeletePostResult | null> {
        const post = await this.deps.getPostById(originAppId, postId);
        if (!post) {
            const ledger = await this.deps.getDeletedPost(originAppId, postId);
            if (!ledger) return null;
            return { status: 'already-deleted', complete: true, deleted: [], kept: [] };
        }

        const page = await this.deleteSubtree(originAppId, post, { replies, budget: this.pageSize });
        await this.drain(originAppId);
        return {
            status: page.removedRoot ? 'deleted' : page.complete ? 'already-deleted' : 'pending',
            complete: page.complete,
            deleted: page.deleted,
            kept: page.kept,
        };
    }

    /**
     * Account erasure: delete every post `authorId` wrote, up to `limit` per
     * call, applying `replies` to the subtrees below them. The author's own
     * posts are always deleted, wherever they sit. `complete` is true once the
     * author has no posts left, so calling again after that is a no-op.
     */
    async eraseAuthor(
        originAppId: string,
        authorId: string,
        replies: RepliesPolicy,
        limit: number,
    ): Promise<EraseAuthorResult> {
        const deleted: DeletedPostRef[] = [];
        const kept: KeptPostRef[] = [];
        let complete = false;
        let lastSubtreeComplete = true;

        while (deleted.length < limit) {
            const [next] = await this.deps.queryByAuthor(originAppId, authorId, { limit: 1 });
            if (!next) {
                complete = true;
                break;
            }
            const page = await this.deleteSubtree(originAppId, next, {
                replies,
                budget: limit - deleted.length,
                eraseAuthorId: authorId,
            });
            deleted.push(...page.deleted);
            kept.push(...page.kept.slice(0, this.pageSize - kept.length));
            // Nothing removed means a concurrent delete got there first, or the
            // budget ran out mid-subtree. Either way, hand back to the caller
            // rather than spin on the same post.
            lastSubtreeComplete = page.complete;
            if (!page.complete || page.deleted.length === 0) break;
        }

        // The budget can run out exactly as the last post goes. One more look
        // tells "done" from "more to do", so a caller never needs a final call
        // only to learn there was nothing left.
        if (!complete && lastSubtreeComplete) {
            const [remaining] = await this.deps.queryByAuthor(originAppId, authorId, { limit: 1 });
            complete = !remaining;
        }

        await this.drain(originAppId);
        return { complete, deleted, kept };
    }

    /** The ledger row for a deleted post, for the `410` on reads. */
    getDeletedPost(originAppId: string, postId: string): Promise<DeletedPostRecord | null> {
        return this.deps.getDeletedPost(originAppId, postId);
    }

    /**
     * Drain the blob-deletion queue across every tenant. The cron's entry
     * point: whatever a crashed or partial call left queued finishes here.
     */
    drainAll(limit: number = DRAIN_BATCH) {
        return this.deps.drainBlobDeletions(null, limit);
    }

    /**
     * Remove up to `budget` posts from `post`'s subtree, deepest first, and the
     * post itself once everything below it that is to go has gone.
     */
    private async deleteSubtree(originAppId: string, post: AudioPostRecord, opts: SubtreeOptions): Promise<SubtreePage> {
        const appDid = this.deps.getAppDid(originAppId);
        const uriOf = (p: AudioPostRecord) => buildPostUri(appDid, p.id, p.space);
        const postUri = uriOf(post);

        // Every reply in the thread, then the walk from this post down. A prompt
        // is its own thread root; a reply's root is named on it.
        const rootUri = post.kind === 'prompt' ? postUri : post.reply!.root.uri;
        const threadReplies = await this.deps.listThreadReplies(originAppId, rootUri);
        const children = new Map<string, AudioPostRecord[]>();
        for (const reply of threadReplies) {
            const parentUri = reply.reply!.parent.uri;
            const siblings = children.get(parentUri);
            if (siblings) siblings.push(reply);
            else children.set(parentUri, [reply]);
        }

        const toDelete: Array<{ record: AudioPostRecord; uri: string; depth: number }> = [];
        const kept: KeptPostRef[] = [];
        const queue: Array<{ uri: string; depth: number }> = [{ uri: postUri, depth: 0 }];
        // A cycle is impossible (a reply names a parent that existed before it),
        // but a corrupt row must not hang a delete, so each URI is walked once.
        const seen = new Set<string>([postUri]);
        while (queue.length > 0) {
            const { uri, depth } = queue.shift()!;
            for (const child of children.get(uri) ?? []) {
                const childUri = uriOf(child);
                if (seen.has(childUri)) continue;
                seen.add(childUri);
                if (this.shouldDelete(child, opts)) {
                    toDelete.push({ record: child, uri: childUri, depth: depth + 1 });
                } else if (kept.length < this.pageSize) {
                    kept.push({ postId: child.id, uri: childUri });
                }
                queue.push({ uri: childUri, depth: depth + 1 });
            }
        }

        // Deepest first, so a partial call removes leaves before their parents.
        toDelete.sort((a, b) => b.depth - a.depth);
        const batch: PostToDelete[] = toDelete
            .slice(0, opts.budget)
            .map(({ record, uri }) => ({ id: record.id, uri, kind: record.kind }));
        const includesRoot = toDelete.length < opts.budget;
        if (includesRoot) batch.push({ id: post.id, uri: postUri, kind: post.kind });

        const removed = new Set(await this.deps.deletePosts(originAppId, batch));
        const deleted = batch
            .filter((p) => removed.has(p.id))
            .map(({ id, uri, kind }) => ({ postId: id, uri, kind }));

        await this.announce(originAppId, deleted);

        return {
            // The post is gone whether this call or a concurrent one removed it.
            complete: includesRoot,
            removedRoot: removed.has(post.id),
            deleted,
            kept,
        };
    }

    private shouldDelete(reply: AudioPostRecord, opts: SubtreeOptions): boolean {
        if (opts.eraseAuthorId !== undefined && reply.authorId === opts.eraseAuthorId) return true;
        switch (opts.replies) {
            case 'delete':
                return true;
            case 'keep':
                return false;
            case 'keep-with-did':
                return !reply.authorDid;
        }
    }

    /** Best-effort `post.deleted` events, after the delete has committed. */
    private async announce(originAppId: string, deleted: DeletedPostRef[]): Promise<void> {
        const occurredAt = new Date().toISOString();
        await Promise.all(
            deleted.map(async ({ postId, uri, kind }) => {
                try {
                    await this.notifier.notifyDeleted({ originAppId, postId, uri, kind, occurredAt });
                } catch (err) {
                    this.logger.error(
                        { err, originAppId, postId },
                        '[post-deletion] post-deleted webhook failed; swallowed (the delete is committed)',
                    );
                }
            }),
        );
    }

    /**
     * Drain this tenant's queued blobs. A failure here leaves them queued for
     * the cron rather than failing a delete whose rows are already gone.
     */
    private async drain(originAppId: string): Promise<void> {
        try {
            await this.deps.drainBlobDeletions(originAppId, DRAIN_BATCH);
        } catch (err) {
            this.logger.error(
                { err, originAppId },
                '[post-deletion] blob drain failed; left queued for the cron',
            );
        }
    }
}
