import { z } from 'zod';
import { TimestampSchema } from './records';

/**
 * DIDs a tenant may write under besides its own app DID
 * (specs/did-plc-and-multi-did-tenancy.md §3, revised by
 * specs/audio-service-and-groups.md G4).
 *
 * A tenant acts for groups: a Bardcast table, a Vox Pop org. Each group has its
 * own DID, created by a group host, whose document names this Antiphony
 * deployment as its space host. The tenant registers that DID here, and
 * Antiphony proves the custody claim before keeping the registration. A DID
 * belongs to at most one tenant.
 *
 * Light checks only, so this package stays dependency-free; `@antiphony/core`
 * validates the DID with `@atproto/syntax`.
 */

/** A DID, by shape: `did:{method}:{id}`. */
export const DidStringSchema = z
    .string()
    .max(2048)
    .regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/, 'Must be a DID');

/**
 * What a registered DID is to the tenant. Only `group` today: Antiphony never
 * holds records under a person's DID, because a person's DID names their own PDS.
 */
export const TenantDidRoleSchema = z.enum(['group']);
export type TenantDidRole = z.infer<typeof TenantDidRoleSchema>;

/** A registered DID as stored. */
export const TenantDidRecordSchema = z.object({
    did: DidStringSchema,
    /** The tenant that may write under it. */
    originAppId: z.string(),
    role: TenantDidRoleSchema,
    /** The tenant's own id for the group (a table id, an org id). Opaque to Antiphony. */
    subjectRef: z.string().max(256).optional(),
    createdAt: TimestampSchema,
});
export type TenantDidRecord = z.infer<typeof TenantDidRecordSchema>;

/** A registered DID as the API returns it. */
export const TenantDidViewSchema = z.object({
    did: DidStringSchema,
    role: TenantDidRoleSchema,
    subjectRef: z.string().max(256).optional(),
    /** ISO 8601. */
    createdAt: z.string(),
});
export type TenantDidView = z.infer<typeof TenantDidViewSchema>;
