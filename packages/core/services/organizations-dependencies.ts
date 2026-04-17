import type {
    OrganizationRecord,
    OrganizationMemberRecord,
    OrgInviteRecord,
} from 'shared/types/records';

/**
 * OrganizationDependencies is the portable interface that OrganizationService
 * uses to access the underlying data store. Lives in `packages/core/`
 * alongside the class; the Firestore-backed default implementation lives
 * in `apps/web/src/services/organizations-dependencies.ts` as the binding.
 *
 * Member docs are keyed on `userId` (the caller supplies the ID), so there is
 * no `newMemberId()` — only `newOrganizationId()` and `newInviteId()`.
 */
export interface OrganizationDependencies {
    // --- Organizations ---

    /** Generate a new unique organization ID without creating the document. */
    newOrganizationId(): string;

    /** Persist an organization record (upsert). */
    saveOrganization(record: OrganizationRecord): Promise<void>;

    /**
     * Atomically create an organization together with its owner member record.
     * Both writes succeed or neither does — preventing orphaned organizations
     * (org exists, no one can access it because no members). Use this instead
     * of sequential `saveOrganization` + `saveMember` for initial creation.
     */
    createOrganizationWithOwner(
        org: OrganizationRecord,
        owner: OrganizationMemberRecord,
    ): Promise<void>;

    /** Fetch an organization by ID, or null if missing. */
    getOrganizationById(orgId: string): Promise<OrganizationRecord | null>;

    /** Fetch an organization by its slug, or null if missing. */
    getOrganizationBySlug(slug: string): Promise<OrganizationRecord | null>;

    /**
     * Fetch every organization the given user is a member of.
     * Implementations should perform the membership lookup + org fetch
     * atomically from the caller's perspective (order of results not specified).
     */
    getOrganizationsForMember(userId: string): Promise<OrganizationRecord[]>;

    /** Apply a partial update to an existing organization. */
    updateOrganization(orgId: string, updates: Partial<OrganizationRecord>): Promise<void>;

    // --- Members ---

    /** Get a member's role in an organization, or null if not a member. */
    getMemberRole(orgId: string, userId: string): Promise<'owner' | 'admin' | 'member' | null>;

    /** List all members of an organization. */
    listMembers(orgId: string): Promise<OrganizationMemberRecord[]>;

    /** Persist a member record (upsert). */
    saveMember(record: OrganizationMemberRecord): Promise<void>;

    /** Update an existing member's role. */
    updateMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void>;

    /** Remove a member from an organization. */
    deleteMember(orgId: string, userId: string): Promise<void>;

    // --- Invites ---

    /** Generate a new unique invite ID without creating the document. */
    newInviteId(orgId: string): string;

    /** Persist an invite record (upsert). */
    saveInvite(record: OrgInviteRecord): Promise<void>;

    /** Fetch an invite by ID, or null if missing. */
    getInviteById(orgId: string, inviteId: string): Promise<OrgInviteRecord | null>;

    /** Update an invite's lifecycle status. */
    updateInviteStatus(
        orgId: string,
        inviteId: string,
        status: OrgInviteRecord['status'],
    ): Promise<void>;

    /**
     * Current server time as a `Date`. Service code uses `Date` uniformly; the
     * implementation converts to whatever the storage layer requires
     * (Firestore accepts `Date` on writes and stores as `Timestamp`).
     */
    now(): Date;
}
