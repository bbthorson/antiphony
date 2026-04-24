import { getAdminDb } from '../lib/firebase-admin.js';
import { OrganizationRecordSchema } from 'shared/types/records';
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
 * **Scope as of this PR**: `getOrganizationBySlug`, `getMemberRole`, and
 * `getOrganizationsForMember` are implemented. The `getOrganizationsForMember`
 * method backs `GET /api/v1/users/me/organizations` — it does a collectionGroup
 * query across every org's `members` subcollection to find every org the user
 * belongs to. Every other method is stubbed and throws on call; each
 * subsequent PR that ports an org-related endpoint fills in the specific
 * methods its endpoint reaches.
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

const notYetPorted = (method: string): never => {
    throw new Error(
        `[core-api organizations-dependencies] ${method} is not yet ported. See apps/core-api/src/services/organizations-dependencies.ts and apps/web/src/services/organizations-dependencies.ts for the binding to mirror.`,
    );
};

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

    // --- Stubbed — fill in as each endpoint ports ---

    newOrganizationId(): string {
        return notYetPorted('newOrganizationId');
    },

    async saveOrganization(_record: OrganizationRecord) {
        return notYetPorted('saveOrganization');
    },

    async createOrganizationWithOwner(_org: OrganizationRecord, _owner: OrganizationMemberRecord) {
        return notYetPorted('createOrganizationWithOwner');
    },

    async getOrganizationById(_orgId: string) {
        return notYetPorted('getOrganizationById');
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

    async updateOrganization(_orgId: string, _updates: Partial<OrganizationRecord>) {
        return notYetPorted('updateOrganization');
    },

    async listMembers(_orgId: string) {
        return notYetPorted('listMembers');
    },

    async saveMember(_record: OrganizationMemberRecord) {
        return notYetPorted('saveMember');
    },

    async updateMemberRole(_orgId: string, _userId: string, _role: 'admin' | 'member') {
        return notYetPorted('updateMemberRole');
    },

    async deleteMember(_orgId: string, _userId: string) {
        return notYetPorted('deleteMember');
    },

    newInviteId(_orgId: string): string {
        return notYetPorted('newInviteId');
    },

    async saveInvite(_record: OrgInviteRecord) {
        return notYetPorted('saveInvite');
    },

    async getInviteById(_orgId: string, _inviteId: string) {
        return notYetPorted('getInviteById');
    },

    async updateInviteStatus(_orgId: string, _inviteId: string, _status: OrgInviteRecord['status']) {
        return notYetPorted('updateInviteStatus');
    },

    now(): Date {
        return new Date();
    },
};
