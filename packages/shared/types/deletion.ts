import { z } from 'zod';

/**
 * Deleting posts and their audio (`specs/deletion.md`).
 *
 * A delete is a hard delete: the post, its transcript and every blob only it
 * used are removed, and a content-free ledger row records that it happened.
 * These are the shapes the delete routes answer with.
 */

/**
 * What happens to the replies below a deleted post (its whole subtree).
 *
 *  - `delete` — every reply in the subtree is deleted with the post.
 *  - `keep` — only the post is deleted; every reply stays, with a parent
 *    StrongRef that no longer resolves.
 *  - `keep-with-did` — each reply is judged on its own: kept when it carries an
 *    `authorDid` facet (its author has their own AT Protocol identity), deleted
 *    when it doesn't.
 *
 * A kept reply is never moved: its URI is sealed into the CID of every reply
 * beneath it, so it keeps its URI, CID and space.
 */
export const RepliesPolicySchema = z.enum(['delete', 'keep', 'keep-with-did']);
export type RepliesPolicy = z.infer<typeof RepliesPolicySchema>;

/** A post a delete call removed. */
export const DeletedPostRefSchema = z.object({
    postId: z.string(),
    uri: z.string(),
    kind: z.enum(['prompt', 'reply']),
});
export type DeletedPostRef = z.infer<typeof DeletedPostRefSchema>;

/** A reply a delete call left in place under a deleted post. */
export const KeptPostRefSchema = z.object({
    postId: z.string(),
    uri: z.string(),
});
export type KeptPostRef = z.infer<typeof KeptPostRefSchema>;

/**
 * What one delete call did. A subtree larger than one call deletes is removed
 * deepest first, with the post itself last, over several calls: `complete` is
 * false until nothing that was asked for remains, and the caller repeats the
 * same call until it is true.
 */
export const DeletionPageSchema = z.object({
    complete: z.boolean(),
    /** Every post this call removed. */
    deleted: z.array(DeletedPostRefSchema),
    /** Replies this call left in place (`keep`, `keep-with-did`). */
    kept: z.array(KeptPostRefSchema),
});
export type DeletionPage = z.infer<typeof DeletionPageSchema>;

/**
 * `DELETE /api/v1/posts/{postId}`.
 *
 *  - `deleted` — this call removed the post.
 *  - `already-deleted` — the ledger already had it. Still a success: the post
 *    is gone, which is what was asked.
 *  - `pending` — the post's subtree needs more calls; the post is still there.
 */
export const DeletePostResultSchema = DeletionPageSchema.extend({
    status: z.enum(['deleted', 'already-deleted', 'pending']),
});
export type DeletePostResult = z.infer<typeof DeletePostResultSchema>;

/** `POST /api/v1/authors/{authorId}/erase`. */
export const EraseAuthorResultSchema = DeletionPageSchema;
export type EraseAuthorResult = z.infer<typeof EraseAuthorResultSchema>;

/** `DELETE /api/v1/spaces/{spaceType}/{skey}`. False when there was no such space. */
export const DeleteSpaceResultSchema = z.object({
    deleted: z.boolean(),
});
export type DeleteSpaceResult = z.infer<typeof DeleteSpaceResultSchema>;
