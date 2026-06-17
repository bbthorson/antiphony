import type { CallForwardingDependencies } from '../ports/call-forwarding-dependencies';

/**
 * CallForwardingService — the telephony SIP reverse-index lookups
 * (phone/dedicated-number → uid).
 *
 * Plan B B3' retired the per-user config CRUD: telephony's call-forwarding
 * config now lives on the connector-config primitive
 * (`connector_configs/{uid}/items/telephony`) and is read/written via the
 * `/api/v1/connectors/*` control plane + `/api/v1/system/connectors/*`
 * ingestion plane. The only thing that stays here is the cross-user reverse
 * index the SIP webhook needs (the binding queries the connector-config store).
 *
 * See `specs/plan-b-connector-boundaries.md`.
 */
export class CallForwardingService {
    constructor(private readonly deps: CallForwardingDependencies) {}

    /**
     * SIP-routing lookup: find the uid behind a free-tier inbound phone number.
     * Returns null when no verified+enabled config matches.
     */
    async findUidByPhoneNumber(phoneNumber: string): Promise<string | null> {
        return this.deps.findUidByPhoneNumber(phoneNumber);
    }

    /**
     * SIP-routing lookup: find the uid behind a paid-tier dedicated VoxPop
     * number. Returns null when no verified config matches.
     */
    async findUidByDedicatedNumber(voxpopNumber: string): Promise<string | null> {
        return this.deps.findUidByDedicatedNumber(voxpopNumber);
    }
}
