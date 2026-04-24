import { getAdminDb } from '../lib/firebase-admin.js';
import {
    OrganizationRecordSchema,
    OrganizationMemberRecordSchema,
    OrgInviteRecordSchema,
} from 'shared/types/records';
import type {
    OrganizationRecord,
    OrganizationMemberRecord,
    OrgInviteRecord,
} from 'shared/types/records';
import type { OrganizationDependencies } from '@vox-pop/core/services/organizations-dependencies';

export type { OrganizationDependencies };

/**
 * Firebase-wired `OrganizationDependencies` binding for core-api.
 *
 * **Scope as of this PR**: `getOrganizationBySlug`, `getMemberRole`,
 * `getOrganizationsForMember`, `getOrganizationById`, and `listMembers` are
 * implemented. `getOrganizationById` + `listMembers` back `GET
 * /api/v1/organizations/:orgId` and `.../members` (Batch A3). Every other
 * method is stubbed and throws on call; each subsequent PR that ports an
 * org-related endpoint fills in the specific methods its endpoint reaches.
 *
 * Parity source: `apps/web/src/services/organizations-dependencies.ts`.
 */

// Firestore's `getAll()` caps at 1000 document refs per call. Chunk in the
// `getOrganizationsForMember` path so a user with > 1000 org memberships
// still resolves (today unreachable in practice, but the right layer to
// enforce the provider limit).
const FIRESTORE_GETALL_LIMIT = 1000;

function orgsCollection() {
    return getAdminDb().collection('organizations');
}

function membersCollection(orgId: string) {
    return orgsCollection().doc(orgId).collection('members');
}

function invitesCollection(orgId: string) {
    return orgsCollection().doc(orgId).collection('invites');
}

export const firebaseOrganizationDependencies: OrganizationDependencies = {
    // --- Implemented: resolve-handle org fallback path ---

    async getOrganizationBySlug(slug: string) {
        const snapshot = await orgsCollection().where('slug', '==', slug).limit(1).get();
        if (snapshot.empty) return null;
        // `OrganizationRecordSchema` requires `id`. Organization docs embed
        // the id in the payload at write time (via `saveOrganization`), so
        // this works today — but merging `doc.id` explicitly makes the bind
        // robust to legacy docs or any future write path that skips embedding.
        const doc = snapshot.docs[0];
        return OrganizationRecordSchema.parse({ id: doc.id, ...doc.data() });
    },

    async getMemberRole(orgId: string, userId: string) {
        // Defensive guard: TypeScript signature says `string`, and the upstream
        // caller (`OrganizationService.getOrganizationBySlug`) only invokes this
        // when `currentUserId` is truthy. But an empty string would still blow
        // up Firestore (`doc('')` throws on build). Treat empty/whitespace as
        // "not a member" rather than letting it surface as a 500.
        if (!userId || !userId.trim()) return null;
        const doc = await membersCollection(orgId).doc(userId).get();
        if (!doc.exists) return null;
        const data = doc.data();
        const role = data?.role;
        if (role === 'owner' || role === 'admin' || role === 'member') return role;
        return null;
    },

    newOrganizationId(): string {
        return orgsCollection().doc().id;
    },

    async saveOrganization(record: OrganizationRecord) {
        await orgsCollection().doc(record.id).set(record);
    },

    async createOrganizationWithOwner(org: OrganizationRecord, owner: OrganizationMemberRecord) {
        const db = getAdminDb();
        // Transactional so the slug reservation in `handles` is atomic with
        // the org + member writes. Apps/web's parity binding does batch-set
        // (not transactional) and omits the `handles` reservation — this
        // closes the shared-namespace race where a user could claim the
        // same slug via POST /handles/claim between the check and the
        // create. The reservation uses `system` as the uid so it can't be
        // confused with a user handle; POST /handles/claim refuses to
        // claim a handle owned by anyone other than the current viewer.
        await db.runTransaction(async (t) => {
            // Re-verify the slug is free inside the transaction. If another
            // writer beat us to it (either an org or a user handle), bail.
            const handleRef = db.collection('handles').doc(org.slug);
            const existingHandle = await t.get(handleRef);
            if (existingHandle.exists) {
                throw new Error('Handle already taken');
            }

            t.set(orgsCollection().doc(org.id), org);
            t.set(membersCollection(org.id).doc(owner.userId), owner);
            t.set(handleRef, {
                uid: 'system',
                orgId: org.id,
                createdAt: org.createdAt,
            });
        });
    },

    async getOrganizationById(orgId: string) {
        if (!orgId || !orgId.trim()) return null;
        const doc = await orgsCollection().doc(orgId).get();
        if (!doc.exists) return null;
        return OrganizationRecordSchema.parse({ id: doc.id, ...doc.data() });
    },

    async getOrganizationsForMember(userId: string) {
        if (!userId || !userId.trim()) return [];
        const db = getAdminDb();
        const membersSnapshot = await db
            .collectionGroup('members')
            .where('userId', '==', userId)
            .get();

        if (membersSnapshot.empty) return [];

        // Extract orgId from the doc's path rather than a denorm field on
        // the member record. collectionGroup('members') returns docs with
        // path `organizations/{orgId}/members/{userId}`, so the grandparent
        // ref's id is authoritative — robust to legacy member docs that
        // may not have embedded `orgId`.
        const orgIds = membersSnapshot.docs
            .map((doc) => doc.ref.parent.parent?.id)
            .filter((id): id is string => Boolean(id));
        if (orgIds.length === 0) return [];

        const allDocs: FirebaseFirestore.DocumentSnapshot[] = [];
        for (let i = 0; i < orgIds.length; i += FIRESTORE_GETALL_LIMIT) {
            const refs = orgIds
                .slice(i, i + FIRESTORE_GETALL_LIMIT)
                .map((id) => orgsCollection().doc(id));
            const chunk = await db.getAll(...refs);
            allDocs.push(...chunk);
        }

        return allDocs
            .filter((doc) => doc.exists)
            .map((doc) => OrganizationRecordSchema.parse({ id: doc.id, ...doc.data() }));
    },

    async updateOrganization(orgId: string, updates: Partial<OrganizationRecord>) {
        await orgsCollection().doc(orgId).update(updates);
    },

    async listMembers(orgId: string) {
        if (!orgId || !orgId.trim()) return [];
        const snapshot = await membersCollection(orgId).get();
        // Member doc IDs are userIds; records embed `userId` + `orgId` at write
        // time. Merge the path-derived ids anyway to be robust to legacy docs
        // that predate the embed — same pattern as `getOrganizationById`.
        return snapshot.docs.map((doc) =>
            OrganizationMemberRecordSchema.parse({
                orgId,
                userId: doc.id,
                ...doc.data(),
            }),
        );
    },

    async saveMember(record: OrganizationMemberRecord) {
        await membersCollection(record.orgId).doc(record.userId).set(record);
    },

    async updateMemberRole(orgId: string, userId: string, role: 'admin' | 'member') {
        await membersCollection(orgId).doc(userId).update({ role });
    },

    async deleteMember(orgId: string, userId: string) {
        await membersCollection(orgId).doc(userId).delete();
    },

    newInviteId(orgId: string): string {
        return invitesCollection(orgId).doc().id;
    },

    async saveInvite(record: OrgInviteRecord) {
        await invitesCollection(record.orgId).doc(record.id).set(record);
    },

    async getInviteById(orgId: string, inviteId: string) {
        const doc = await invitesCollection(orgId).doc(inviteId).get();
        if (!doc.exists) return null;
        return OrgInviteRecordSchema.parse({ id: doc.id, ...doc.data() });
    },

    async updateInviteStatus(orgId: string, inviteId: string, status: OrgInviteRecord['status']) {
        await invitesCollection(orgId).doc(inviteId).update({ status });
    },

    now(): Date {
        return new Date();
    },
};
