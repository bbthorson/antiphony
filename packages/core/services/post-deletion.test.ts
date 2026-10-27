import { describe, it, expect, vi } from 'vitest';
import type { AudioPostRecord } from 'shared/types/audio';
import type { DeletedPostRecord, PostDeletionDependencies } from '../ports/post-deletion-dependencies';
import { inMemoryAudioPostDependencies } from '../testing/in-memory-audio-post-dependencies';
import { buildPostUri } from './audio-posts';
import { PostDeletionService } from './post-deletion';

/**
 * `PostDeletionService` against an in-memory store: which posts a delete
 * removes and keeps, in what order, over how many calls, and what it reports.
 * The SQL that does the removing — atomicity, the blob queue, the reference
 * check against shared blobs — is exercised against real Postgres in
 * `apps/core-api/src/adapters/outbound/postgres/post-deletion.test.ts`.
 */

const TENANT = 'voxpop';
const APP_DID = `did:web:${TENANT}.example`;

function store() {
    const posts = inMemoryAudioPostDependencies();
    const ledger = new Map<string, DeletedPostRecord>();
    const drains: Array<string | null> = [];
    const deps: PostDeletionDependencies = {
        getAppDid: posts.getAppDid,
        getPostById: posts.getPostById,
        queryByAuthor: posts.queryByAuthor,
        async getDeletedPost(originAppId, postId) {
            return ledger.get(`${originAppId}/${postId}`) ?? null;
        },
        async listThreadReplies(originAppId, rootUri) {
            return [...posts.posts.values()].filter(
                (p) => p.originAppId === originAppId && p.kind === 'reply' && p.reply?.root.uri === rootUri,
            );
        },
        async deletePosts(originAppId, toDelete) {
            const removed: string[] = [];
            for (const p of toDelete) {
                const stored = posts.posts.get(p.id);
                if (!stored || stored.originAppId !== originAppId) continue;
                posts.posts.delete(p.id);
                ledger.set(`${originAppId}/${p.id}`, { postId: p.id, uri: p.uri, kind: stored.kind, deletedAt: new Date() });
                removed.push(p.id);
            }
            return removed;
        },
        async drainBlobDeletions(originAppId) {
            drains.push(originAppId);
            return { deleted: 0, retained: 0 };
        },
    };
    return { posts, deps, ledger, drains };
}

let seq = 0;
function tid(): string {
    seq += 1;
    return `3kp${String(seq).padStart(10, '0')}`;
}

function prompt(authorId: string): AudioPostRecord {
    return {
        id: tid(),
        cid: `bafyprompt${seq}`,
        originAppId: TENANT,
        authorId,
        kind: 'prompt',
        text: 'what should we cover?',
        createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)),
    };
}

function reply(parent: AudioPostRecord, authorId: string, opts: { authorDid?: string } = {}): AudioPostRecord {
    const parentRef = { uri: buildPostUri(APP_DID, parent.id, parent.space), cid: parent.cid };
    const root = parent.kind === 'prompt' ? parentRef : parent.reply!.root;
    return {
        id: tid(),
        cid: `bafyreply${seq}`,
        originAppId: TENANT,
        authorId,
        ...(opts.authorDid ? { authorDid: opts.authorDid } : {}),
        kind: 'reply',
        rootAuthorId: parent.kind === 'prompt' ? parent.authorId : parent.rootAuthorId!,
        reply: { root, parent: parentRef },
        text: '',
        createdAt: new Date(Date.UTC(2026, 9, 20, 0, 0, seq)),
    };
}

async function seed(s: ReturnType<typeof store>, ...records: AudioPostRecord[]) {
    for (const r of records) await s.posts.savePost(r);
}

const ids = (refs: Array<{ postId: string }>) => refs.map((r) => r.postId).sort();

describe('PostDeletionService.deletePost', () => {
    it('deletes a prompt and, by default, its whole subtree', async () => {
        const s = store();
        const p = prompt('creator');
        const r1 = reply(p, 'listener-a');
        const r2 = reply(r1, 'creator');
        const r3 = reply(p, 'listener-b', { authorDid: 'did:plc:listenerb' });
        await seed(s, p, r1, r2, r3);

        const result = await new PostDeletionService(s.deps).deletePost(TENANT, p.id, 'delete');

        expect(result).toMatchObject({ status: 'deleted', complete: true, kept: [] });
        expect(ids(result!.deleted)).toEqual([p.id, r1.id, r2.id, r3.id].sort());
        expect(s.posts.posts.size).toBe(0);
        expect(s.drains).toEqual([TENANT]);
    });

    it('removes the deepest replies first and the post itself last', async () => {
        const s = store();
        const p = prompt('creator');
        const r1 = reply(p, 'a');
        const r2 = reply(r1, 'b');
        const r3 = reply(r2, 'c');
        await seed(s, p, r1, r2, r3);

        const result = await new PostDeletionService(s.deps).deletePost(TENANT, p.id, 'delete');

        expect(result!.deleted.map((d) => d.postId)).toEqual([r3.id, r2.id, r1.id, p.id]);
    });

    it('keeps every reply with `keep`, leaving their parent StrongRef dangling', async () => {
        const s = store();
        const p = prompt('creator');
        const r1 = reply(p, 'a');
        const r2 = reply(r1, 'b');
        await seed(s, p, r1, r2);

        const result = await new PostDeletionService(s.deps).deletePost(TENANT, p.id, 'keep');

        expect(ids(result!.deleted)).toEqual([p.id]);
        expect(ids(result!.kept)).toEqual([r1.id, r2.id].sort());
        // Untouched: same record, same StrongRef to a post that is gone.
        expect(s.posts.posts.get(r1.id)).toEqual(r1);
    });

    it('keeps only the replies with an authorDid under `keep-with-did`, judging each on its own', async () => {
        const s = store();
        const p = prompt('creator');
        const linked = reply(p, 'listener-linked', { authorDid: 'did:plc:linked' });
        const underLinked = reply(linked, 'creator'); // no DID: deleted though its parent stays
        const sms = reply(p, 'listener-sms');
        const linkedUnderSms = reply(sms, 'listener-linked', { authorDid: 'did:plc:linked' });
        await seed(s, p, linked, underLinked, sms, linkedUnderSms);

        const result = await new PostDeletionService(s.deps).deletePost(TENANT, p.id, 'keep-with-did');

        expect(ids(result!.deleted)).toEqual([p.id, underLinked.id, sms.id].sort());
        expect(ids(result!.kept)).toEqual([linked.id, linkedUnderSms.id].sort());
        expect([...s.posts.posts.keys()].sort()).toEqual([linked.id, linkedUnderSms.id].sort());
    });

    it('deletes a reply and its own subtree, leaving the rest of the thread', async () => {
        const s = store();
        const p = prompt('creator');
        const r1 = reply(p, 'a');
        const r1child = reply(r1, 'creator');
        const r2 = reply(p, 'b');
        await seed(s, p, r1, r1child, r2);

        const result = await new PostDeletionService(s.deps).deletePost(TENANT, r1.id, 'delete');

        expect(ids(result!.deleted)).toEqual([r1.id, r1child.id].sort());
        expect([...s.posts.posts.keys()].sort()).toEqual([p.id, r2.id].sort());
    });

    it('pages a large subtree, never removing the post before its replies', async () => {
        const s = store();
        const p = prompt('creator');
        const replies = Array.from({ length: 5 }, () => reply(p, 'a'));
        await seed(s, p, ...replies);
        const service = new PostDeletionService(s.deps, undefined, undefined, 2);

        const first = await service.deletePost(TENANT, p.id, 'delete');
        expect(first).toMatchObject({ status: 'pending', complete: false });
        expect(first!.deleted).toHaveLength(2);
        expect(s.posts.posts.has(p.id)).toBe(true);

        const second = await service.deletePost(TENANT, p.id, 'delete');
        expect(second).toMatchObject({ status: 'pending', complete: false });

        // One reply left: it and the post fit, so the post goes last.
        const third = await service.deletePost(TENANT, p.id, 'delete');
        expect(third).toMatchObject({ status: 'deleted', complete: true });
        expect(third!.deleted.map((d) => d.postId).at(-1)).toBe(p.id);
        expect(s.posts.posts.size).toBe(0);
    });

    it('answers already-deleted for a post in the ledger, and null for one never seen', async () => {
        const s = store();
        const p = prompt('creator');
        await seed(s, p);
        const service = new PostDeletionService(s.deps);

        await service.deletePost(TENANT, p.id, 'delete');
        expect(await service.deletePost(TENANT, p.id, 'delete')).toEqual({
            status: 'already-deleted',
            complete: true,
            deleted: [],
            kept: [],
        });
        expect(await service.deletePost(TENANT, '3knever0000000', 'delete')).toBeNull();
    });

    it("treats another tenant's post as absent", async () => {
        const s = store();
        const p = { ...prompt('creator'), originAppId: 'bardcast' };
        await seed(s, p);

        expect(await new PostDeletionService(s.deps).deletePost(TENANT, p.id, 'delete')).toBeNull();
        expect(s.posts.posts.has(p.id)).toBe(true);
    });

    it('sends a post.deleted event per deleted post, and a failing webhook does not fail the delete', async () => {
        const s = store();
        const p = prompt('creator');
        const r1 = reply(p, 'a');
        await seed(s, p, r1);
        const notifyDeleted = vi.fn(async () => {
            throw new Error('receiver down');
        });
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

        const result = await new PostDeletionService(s.deps, { notifyDeleted }, logger).deletePost(TENANT, p.id, 'delete');

        expect(result!.status).toBe('deleted');
        expect(notifyDeleted).toHaveBeenCalledTimes(2);
        expect(notifyDeleted).toHaveBeenCalledWith(
            expect.objectContaining({ originAppId: TENANT, postId: p.id, kind: 'prompt', uri: buildPostUri(APP_DID, p.id) }),
        );
        expect(logger.error).toHaveBeenCalled();
    });

    it('still answers when the blob drain fails, leaving the queue to the cron', async () => {
        const s = store();
        const p = prompt('creator');
        await seed(s, p);
        s.deps.drainBlobDeletions = async () => {
            throw new Error('R2 unavailable');
        };
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

        const result = await new PostDeletionService(s.deps, undefined, logger).deletePost(TENANT, p.id, 'delete');

        expect(result!.status).toBe('deleted');
        expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('left queued'));
    });
});

describe('PostDeletionService.eraseAuthor', () => {
    it("deletes the author's prompts with their subtrees, and the author's replies elsewhere", async () => {
        const s = store();
        const own = prompt('creator');
        const toOwn = reply(own, 'listener');
        const keptToOwn = reply(own, 'listener-linked', { authorDid: 'did:plc:linked' });
        const other = prompt('someone-else');
        const creatorReplyElsewhere = reply(other, 'creator', { authorDid: 'did:plc:creator' });
        const untouched = reply(other, 'listener');
        await seed(s, own, toOwn, keptToOwn, other, creatorReplyElsewhere, untouched);

        const result = await new PostDeletionService(s.deps).eraseAuthor(TENANT, 'creator', 'keep-with-did', 100);

        expect(result.complete).toBe(true);
        // The creator's own reply goes even though it has a DID: `replies`
        // governs other people's replies, never the author's own posts.
        expect(ids(result.deleted)).toEqual([own.id, toOwn.id, creatorReplyElsewhere.id].sort());
        expect(ids(result.kept)).toEqual([keptToOwn.id]);
        expect([...s.posts.posts.keys()].sort()).toEqual([keptToOwn.id, other.id, untouched.id].sort());
    });

    it('pages by limit, and is a no-op once complete', async () => {
        const s = store();
        const prompts = Array.from({ length: 3 }, () => prompt('creator'));
        await seed(s, ...prompts);
        const service = new PostDeletionService(s.deps);

        const first = await service.eraseAuthor(TENANT, 'creator', 'delete', 2);
        expect(first.complete).toBe(false);
        expect(first.deleted).toHaveLength(2);

        const second = await service.eraseAuthor(TENANT, 'creator', 'delete', 2);
        expect(second.complete).toBe(true);
        expect(second.deleted).toHaveLength(1);

        expect(await service.eraseAuthor(TENANT, 'creator', 'delete', 2)).toEqual({ complete: true, deleted: [], kept: [] });
    });

    it('stops at the limit inside a large subtree and resumes there', async () => {
        const s = store();
        const p = prompt('creator');
        const replies = Array.from({ length: 3 }, () => reply(p, 'listener'));
        await seed(s, p, ...replies);
        const service = new PostDeletionService(s.deps);

        const first = await service.eraseAuthor(TENANT, 'creator', 'delete', 2);
        expect(first).toMatchObject({ complete: false });
        expect(s.posts.posts.has(p.id)).toBe(true);

        const second = await service.eraseAuthor(TENANT, 'creator', 'delete', 2);
        expect(second.complete).toBe(true);
        expect(s.posts.posts.size).toBe(0);
    });
});
