import { isValidDid } from '@atproto/syntax';
import { NotFoundError, ServiceError, ValidationError } from 'shared/errors';
import type { TenantDidRecord, TenantDidRole, TenantDidView } from 'shared/types/dids';
import type { DidRegistryDependencies, TenantDidPage } from '../ports/did-registry-dependencies';

/** 409: the DID is another tenant's (registered, or pinned as its app DID). */
export const DID_TAKEN = 'DID_TAKEN';
/** 409: this tenant already registered the DID, with a different role or subject. */
export const DID_REGISTERED_DIFFERENTLY = 'DID_REGISTERED_DIFFERENTLY';
/** 400: the DID's document doesn't name this deployment as its space host. */
export const DID_CUSTODY_DISPROVED = 'DID_CUSTODY_DISPROVED';
/** 503: the DID's document couldn't be read; try again. */
export const DID_UNREACHABLE = 'DID_UNREACHABLE';
/** 503: this deployment can't check custody (no `ANTIPHONY_PDS_HOST`), so it registers nothing. */
export const DIDS_UNAVAILABLE = 'DIDS_UNAVAILABLE';

/** The most registrations one page returns. */
export const MAX_DID_PAGE = 200;

/**
 * DidRegistryService — the DIDs a tenant may write under besides its app DID
 * (specs/did-plc-and-multi-did-tenancy.md §3; specs/audio-service-and-groups.md
 * G4).
 *
 * A tenant acts for groups (a Bardcast table, a Vox Pop org), each with a DID a
 * group host created. Registering one here is the tenant's claim that it acts
 * for that group. Three things make the claim safe to keep:
 *
 *  1. **Custody is proven at registration.** The DID's document must name this
 *     deployment as its space host, as the app DID's does. A DID that doesn't
 *     point at us is refused, so a tenant can't put its records under someone
 *     else's identity.
 *  2. **One tenant per DID.** A DID registered by, or pinned as the app DID of,
 *     another tenant is refused, so tenant A can never write as tenant B's group.
 *  3. **Registrations aren't rewritten.** Repeating one is a no-op; changing its
 *     role or subject is refused, because records may already be sealed under it.
 *
 * Registering doesn't yet let a write go under the DID: that is the next step
 * (posts and spaces naming their authority), which also re-proves custody on
 * the write path the way the app DID is re-proven hourly.
 */
export class DidRegistryService {
    constructor(private readonly deps: DidRegistryDependencies) {}

    async register(input: {
        originAppId: string;
        did: string;
        role: TenantDidRole;
        subjectRef?: string;
    }): Promise<{ view: TenantDidView; created: boolean }> {
        const { originAppId, did } = input;
        if (!isValidDid(did)) throw new ValidationError(`Not a valid DID: ${did}`);
        if (did === this.deps.getAppDid(originAppId)) {
            throw new ValidationError("That is this app's own DID, which every write may already use");
        }
        if (this.deps.isPinnedAppDid(did)) throw takenError();

        const existing = await this.deps.getTenantDid(did);
        if (existing) return { view: this.sameOrRefuse(existing, input), created: false };

        const proof = await this.deps.proveCustody(did);
        if (!proof.ok) {
            if (proof.kind === 'unconfigured') {
                throw new ServiceError(
                    "Registering DIDs is unavailable: this deployment doesn't know its own host, so it can't check custody",
                    503,
                    undefined,
                    DIDS_UNAVAILABLE,
                );
            }
            if (proof.kind === 'unreachable') {
                throw new ServiceError(`Couldn't read the DID document for ${did}; try again`, 503, undefined, DID_UNREACHABLE);
            }
            throw new ServiceError(
                `The DID document for ${did} doesn't name this deployment as its space host (${proof.reason})`,
                400,
                undefined,
                DID_CUSTODY_DISPROVED,
            );
        }

        const outcome = await this.deps.insertTenantDid({
            originAppId,
            did,
            role: input.role,
            ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
        });
        const stored = await this.deps.getTenantDid(did);
        if (!stored) throw new Error('[did-registry] registration vanished after insert');
        // Another request registered it between our read and our insert: judge
        // that row exactly as if we had read it first.
        if (outcome === 'exists') return { view: this.sameOrRefuse(stored, input), created: false };
        return { view: toView(stored), created: true };
    }

    /** One of the calling tenant's registrations. Another tenant's reads as missing. */
    async get(originAppId: string, did: string): Promise<TenantDidView> {
        const stored = isValidDid(did) ? await this.deps.getTenantDid(did) : null;
        if (!stored || stored.originAppId !== originAppId) throw new NotFoundError('DID not registered');
        return toView(stored);
    }

    async list(
        originAppId: string,
        opts: { limit?: number; cursor?: string } = {},
    ): Promise<{ items: TenantDidView[]; nextCursor: string | null }> {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_DID_PAGE);
        const page: TenantDidPage = await this.deps.listTenantDids(originAppId, {
            limit,
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
        });
        return { items: page.items.map(toView), nextCursor: page.nextCursor };
    }

    private sameOrRefuse(
        stored: TenantDidRecord,
        input: { originAppId: string; role: TenantDidRole; subjectRef?: string },
    ): TenantDidView {
        if (stored.originAppId !== input.originAppId) throw takenError();
        if (stored.role !== input.role || stored.subjectRef !== input.subjectRef) {
            throw new ServiceError(
                'This DID is already registered with a different role or subject; registrations are not rewritten',
                409,
                undefined,
                DID_REGISTERED_DIFFERENTLY,
            );
        }
        return toView(stored);
    }
}

function takenError(): ServiceError {
    return new ServiceError('This DID belongs to another app', 409, undefined, DID_TAKEN);
}

function toView(stored: TenantDidRecord): TenantDidView {
    return {
        did: stored.did,
        role: stored.role,
        ...(stored.subjectRef !== undefined ? { subjectRef: stored.subjectRef } : {}),
        createdAt: stored.createdAt.toISOString(),
    };
}
