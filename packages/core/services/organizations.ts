import {
    OrganizationRecord,
    OrganizationRecordSchema,
    OrganizationMemberRecord,
    OrganizationMemberRecordSchema,
    OrgInviteRecord,
    OrgInviteRecordSchema,
} from 'shared/types/records';
import type { OrganizationView, OrganizationMemberView, OrgInviteView } from 'shared/types/views';
import type { CoreServices } from '../ports/core-services';
import type { OrganizationDependencies } from '../ports/organizations-dependencies';

/**
 * OrganizationService is the business-logic layer for organizations, members,
 * and invites: validation, hydration, role enforcement. Data access is
 * delegated to an injected `OrganizationDependencies` binding; peer-service
 * access (specifically, HydrationService for view building) flows through
 * the injected `CoreServices` (Phase 2.5 DI container).
 *
 * Lives in `packages/core/` as of Task E.4. The Firebase-backed binding and
 * singleton construction live in `apps/web/src/services/organizations.ts`
 * as the composition layer.
 */
export class OrganizationService {
    /**
     * Both params required — core cannot import the Firebase-backed default
     * bindings. Composition lives in `apps/web/`.
     */
    constructor(
        private readonly deps: OrganizationDependencies,
        private readonly services: CoreServices,
    ) {}

    // =========================================================================
    // Organization CRUD
    // =========================================================================

    /**
     * Creates a new organization and adds the creator as the owner.
     */
    async createOrganization(
        ownerId: string,
        data: { name: string; slug: string; avatarUrl?: string; rssFeedUrl?: string; websiteUrl?: string; description?: string },
    ): Promise<OrganizationRecord> {
        const id = this.deps.newOrganizationId();
        const now = this.deps.now();

        const orgData = {
            id,
            ownerId,
            createdAt: now,
            domainVerified: false,
            // Entry-level paid org tier, per the canonical two-track model (orgs are
            // business→enterprise; free/pro on the enum are for individuals). Creation is
            // currently ungated and there's no Stripe wiring, so a new org lands here with
            // no stripeCustomerId/subscriptionStatus — i.e. it *looks* paid but isn't yet.
            // When billing lands, reconcile which 'business' orgs actually paid vs. defaulted
            // here. See docs/tech-debt.md "Org tier billing reconciliation".
            tier: 'business' as const,
            ...data,
        };

        const validatedOrg = OrganizationRecordSchema.parse(orgData);

        const memberData: OrganizationMemberRecord = {
            orgId: id,
            userId: ownerId,
            role: 'owner',
            joinedAt: now,
        };
        const validatedMember = OrganizationMemberRecordSchema.parse(memberData);

        // Atomic: a partial write here would orphan the organization (no owner
        // can administer it) AND claim the slug, so retries hit conflicts.
        await this.deps.createOrganizationWithOwner(validatedOrg, validatedMember);

        return validatedOrg;
    }

    /**
     * Partially updates an organization. Only admin+ can call this.
     */
    async updateOrganization(orgId: string, data: Record<string, unknown>): Promise<OrganizationRecord> {
        const existing = await this.deps.getOrganizationById(orgId);
        if (!existing) throw new Error('Organization not found');

        // Filter out undefined values
        const updates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) updates[key] = value;
        }

        await this.deps.updateOrganization(orgId, updates as Partial<OrganizationRecord>);

        const updated = await this.deps.getOrganizationById(orgId);
        if (!updated) throw new Error('Organization not found after update');
        return updated;
    }

    /**
     * Retrieves an organization by its ID, hydrated as a View.
     */
    async getOrganization(orgId: string, currentUserId?: string): Promise<OrganizationView | null> {
        const record = await this.deps.getOrganizationById(orgId);
        if (!record) return null;

        let role = undefined;
        if (currentUserId) {
            role = (await this.deps.getMemberRole(orgId, currentUserId)) || undefined;
        }
        return this.services.hydration.hydrateOrganization(record, role);
    }

    /**
     * Retrieves an organization by its slug, hydrated as a View.
     */
    async getOrganizationBySlug(slug: string, currentUserId?: string): Promise<OrganizationView | null> {
        const record = await this.deps.getOrganizationBySlug(slug);
        if (!record) return null;

        let role = undefined;
        if (currentUserId) {
            role = (await this.deps.getMemberRole(record.id, currentUserId)) || undefined;
        }
        return this.services.hydration.hydrateOrganization(record, role);
    }

    /**
     * Retrieves all organizations a user is a member of, hydrated as Views.
     */
    async getUserOrganizations(userId: string): Promise<OrganizationView[]> {
        const records = await this.deps.getOrganizationsForMember(userId);
        if (records.length === 0) return [];
        return this.services.hydration.hydrateOrganizations(records, userId);
    }

    // =========================================================================
    // Member Management
    // =========================================================================

    /**
     * Check if a user is a member of an organization.
     */
    async isMember(orgId: string, userId: string): Promise<boolean> {
        const role = await this.deps.getMemberRole(orgId, userId);
        return role !== null;
    }

    /**
     * Get a member's role in an organization. Returns null if not a member.
     */
    async getMemberRole(orgId: string, userId: string): Promise<'owner' | 'admin' | 'member' | null> {
        return this.deps.getMemberRole(orgId, userId);
    }

    /**
     * Lists all members of an organization, hydrated as Views.
     */
    async getMembers(orgId: string): Promise<OrganizationMemberView[]> {
        const records = await this.deps.listMembers(orgId);
        return this.services.hydration.hydrateMembers(records);
    }

    /**
     * Adds a user as a member of an organization.
     */
    async addMember(
        orgId: string,
        userId: string,
        role: 'admin' | 'member',
        invitedBy?: string,
    ): Promise<OrganizationMemberRecord> {
        const existingRole = await this.deps.getMemberRole(orgId, userId);
        if (existingRole !== null) throw new Error('User is already a member');

        const memberData: OrganizationMemberRecord = {
            orgId,
            userId,
            role,
            joinedAt: this.deps.now(),
            invitedBy,
        };

        const validated = OrganizationMemberRecordSchema.parse(memberData);
        await this.deps.saveMember(validated);
        return validated;
    }

    /**
     * Updates a member's role. Cannot change the owner's role.
     */
    async updateMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
        const currentRole = await this.deps.getMemberRole(orgId, userId);
        if (currentRole === null) throw new Error('Member not found');
        if (currentRole === 'owner') throw new Error('Cannot change owner role');

        await this.deps.updateMemberRole(orgId, userId, role);
    }

    /**
     * Removes a member from an organization. Owner cannot be removed.
     */
    async removeMember(orgId: string, userId: string): Promise<void> {
        const currentRole = await this.deps.getMemberRole(orgId, userId);
        if (currentRole === null) throw new Error('Member not found');
        if (currentRole === 'owner') throw new Error('Cannot remove the owner');

        await this.deps.deleteMember(orgId, userId);
    }

    // =========================================================================
    // Invites
    // =========================================================================

    /**
     * Creates an invite for a user to join an organization.
     */
    async createInvite(
        orgId: string,
        data: { email: string; role: 'admin' | 'member'; invitedBy: string },
    ): Promise<OrgInviteRecord> {
        const id = this.deps.newInviteId(orgId);
        const now = this.deps.now();

        // Invite expires in 7 days.
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const inviteData: OrgInviteRecord = {
            id,
            orgId,
            email: data.email,
            role: data.role,
            invitedBy: data.invitedBy,
            status: 'pending',
            createdAt: now,
            expiresAt,
        };

        const validated = OrgInviteRecordSchema.parse(inviteData);
        await this.deps.saveInvite(validated);
        return validated;
    }

    /**
     * Retrieves an invite by ID, hydrated as a View.
     */
    async getInvite(orgId: string, inviteId: string): Promise<OrgInviteView | null> {
        const record = await this.deps.getInviteById(orgId, inviteId);
        if (!record) return null;
        return this.services.hydration.hydrateInvite(record);
    }

    /**
     * Accepts an invite: marks it accepted and adds the user as a member.
     * Reads invite → checks expiry → writes member → updates invite.
     * This is orchestration, not a transaction — sequential service calls
     * match the existing non-atomic behavior.
     */
    async acceptInvite(orgId: string, inviteId: string, userId: string): Promise<OrganizationMemberRecord> {
        const invite = await this.deps.getInviteById(orgId, inviteId);
        if (!invite) throw new Error('Invite not found');
        if (invite.status !== 'pending') throw new Error('Invite is no longer valid');

        // Check expiry.
        const now = this.deps.now();
        if (invite.expiresAt < now) {
            await this.deps.updateInviteStatus(orgId, inviteId, 'expired');
            throw new Error('Invite has expired');
        }

        const memberData: OrganizationMemberRecord = {
            orgId,
            userId,
            role: invite.role,
            joinedAt: now,
            invitedBy: invite.invitedBy,
        };

        const validated = OrganizationMemberRecordSchema.parse(memberData);

        await this.deps.saveMember(validated);
        await this.deps.updateInviteStatus(orgId, inviteId, 'accepted');

        return validated;
    }

}
