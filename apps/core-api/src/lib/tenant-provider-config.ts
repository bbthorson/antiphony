import { logger } from './logger.js';

/**
 * Per-tenant provider and model overrides — the tenant-scoped layer over the
 * deployment-wide selection in `provider-registry.ts`.
 *
 * Follows the established per-tenant registry shape (`ANTIPHONY_APP_TOKENS`,
 * `ANTIPHONY_APP_DIDS`, `ANTIPHONY_APP_WEBHOOK_URLS`): `appId:value`
 * comma-separated, cached parse, fail-closed per entry.
 *
 *   - `ANTIPHONY_APP_TRANSCRIBERS` — `voxpop:elevenlabs,acme:stub`
 *   - `ANTIPHONY_APP_DENOISERS`    — same shape
 *   - `ANTIPHONY_APP_TRIMMERS`     — same shape
 *   - `ANTIPHONY_APP_WAVEFORMS`    — same shape
 *   - `ANTIPHONY_APP_STT_MODELS`   — `voxpop:scribe_v2,acme:scribe_v1`
 *
 * **Ops config, not tenant-facing.** A tenant cannot name its own model over
 * the API: the model reaches the provider through deployment config only, so a
 * tenant can never invoke an arbitrary expensive model on the deployment's key.
 * That is the whole reason this is an env registry rather than a request field.
 *
 * Absent is the normal case. A tenant with no entry gets the deployment
 * default, so every existing deployment is unaffected by this module existing.
 */

/** Which env var carries each stage's per-tenant provider choice. */
export const TENANT_PROVIDER_VARS = {
    transcribe: 'ANTIPHONY_APP_TRANSCRIBERS',
    denoise: 'ANTIPHONY_APP_DENOISERS',
    trim: 'ANTIPHONY_APP_TRIMMERS',
    waveform: 'ANTIPHONY_APP_WAVEFORMS',
} as const;

/**
 * Which env var carries each stage's per-tenant model choice.
 *
 * Only stages whose providers HAVE a model appear here. `denoise` is absent
 * because `/audio-isolation` accepts no `model_id`, and `trim`/`waveform` are
 * local compute — see `specs/provider-selection.md` § 3.
 */
export const TENANT_MODEL_VARS = {
    transcribe: 'ANTIPHONY_APP_STT_MODELS',
} as const;

export type TenantProviderStage = keyof typeof TENANT_PROVIDER_VARS;
export type TenantModelStage = keyof typeof TENANT_MODEL_VARS;

/** Cache keyed on the raw env string, so a changed value re-parses (tests). */
const caches = new Map<string, { raw: string | undefined; pairs: Map<string, string> }>();

/**
 * This tenant's provider name for a stage, or undefined to take the
 * deployment default.
 */
export function tenantProvider(
    stage: TenantProviderStage,
    originAppId: string,
): string | undefined {
    return pairsFor(TENANT_PROVIDER_VARS[stage]).get(originAppId);
}

/**
 * This tenant's model for a stage, or undefined to take the adapter's own
 * default (`ELEVENLABS_STT_MODEL`, then the adapter constant).
 */
export function tenantModel(stage: TenantModelStage, originAppId: string): string | undefined {
    return pairsFor(TENANT_MODEL_VARS[stage]).get(originAppId);
}

function pairsFor(varName: string): Map<string, string> {
    const raw = process.env[varName];
    const hit = caches.get(varName);
    if (hit && hit.raw === raw) return hit.pairs;
    const pairs = parsePairs(raw, varName);
    caches.set(varName, { raw, pairs });
    return pairs;
}

/**
 * Parse `appId:value` comma-separated pairs, splitting on the FIRST colon —
 * mirroring `parseAppDids` and `webhook-config.ts`'s parser. A malformed entry
 * drops with an error log rather than failing the whole var, so one bad pair
 * cannot take out every other tenant's config.
 *
 * Unlike those two there is no value validator: a provider name is checked
 * against the registry (which knows the valid names) and a model id is
 * deliberately unvalidated, for the reason given in `resolveModel`.
 */
function parsePairs(raw: string | undefined, varName: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!raw || !raw.trim()) return out;
    for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const appId = sep > 0 ? trimmed.slice(0, sep).trim() : '';
        const value = sep > 0 ? trimmed.slice(sep + 1).trim() : '';
        if (!appId || !value) {
            logger.error(
                { entry: trimmed.slice(0, 24) },
                `[tenant-providers] malformed ${varName} entry; ignoring`,
            );
            continue;
        }
        out.set(appId, value);
    }
    return out;
}
