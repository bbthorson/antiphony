/**
 * Port for the telephony SIP reverse-index lookups.
 *
 * Plan B B3' retired the per-user call-forwarding config CRUD — telephony now
 * reads/writes its config through the connector-config primitive
 * (`connector_configs/{uid}/items/telephony`). What remains here is the
 * cross-user reverse index the SIP webhook needs: phone/dedicated-number → uid.
 * The binding queries the connector-config storage. This interface is portable —
 * an alternative store can implement it without touching the service or routes.
 *
 * See `specs/plan-b-connector-boundaries.md` and
 * `specs/connector-ingestion-contract.md`.
 */
export interface CallForwardingDependencies {
    /**
     * Find the uid of the user whose forwarding is configured for a given
     * inbound free-tier phone number. Only matches a routable config
     * (verified + enabled); returns null otherwise — NOT an error.
     */
    findUidByPhoneNumber(phoneNumber: string): Promise<string | null>;

    /**
     * Find the uid of the user assigned a given paid-tier dedicated VoxPop
     * number. Returns null when no match is found.
     */
    findUidByDedicatedNumber(voxpopNumber: string): Promise<string | null>;
}
