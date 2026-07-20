import { logger } from './logger.js';

/**
 * Per-tenant enrichment-webhook registry — the core→BFF direction from
 * `specs/enrichment-webhooks.md`. Each tenant (`originAppId`) that wants
 * stage-settled webhooks maps to a `{ url, secret }`: where to POST, and the
 * HMAC-SHA256 key the receiver recomputes over the raw body.
 *
 * Split across two env vars, following the `ANTIPHONY_APP_TOKENS` /
 * `ANTIPHONY_APP_DIDS` shape (`appId:value` comma-separated, cached parse,
 * fail-closed per entry):
 *   - `ANTIPHONY_APP_WEBHOOK_URLS`    — `appId:https://bff/hooks,appId2:https://…`
 *   - `ANTIPHONY_APP_WEBHOOK_SECRETS` — `appId:secret,appId2:secret`
 *
 * A tenant present in BOTH gets webhooks; a tenant in NEITHER is a silent
 * opt-out (the pull paths still work) — exactly parallel to a deployment with
 * no queue config falling back to noop dispatch. A tenant in EXACTLY ONE is a
 * misconfiguration (a url with no secret would push unsigned, a secret with no
 * url has nowhere to push) and is logged at `error` and excluded, the same
 * discipline `resolveDispatcher` applies to partial Cloud Tasks config. Both
 * "no config" and "partial config" therefore resolve to no webhook — the safe
 * outcome — and only the log distinguishes them.
 */

export interface WebhookConfig {
    url: string;
    secret: string;
}

let cached: {
    urlsRaw: string | undefined;
    secretsRaw: string | undefined;
    configs: Map<string, WebhookConfig>;
} | null = null;

/**
 * The fully-configured tenants, `originAppId → { url, secret }`. Cached on the
 * raw env strings so the notify path pays no re-parse; the cross-check that logs
 * partial config runs once per (re)parse rather than per event, keeping a
 * misconfiguration loud without spamming a line per settled stage.
 */
export function webhookConfigs(
    urlsRaw: string | undefined = process.env.ANTIPHONY_APP_WEBHOOK_URLS,
    secretsRaw: string | undefined = process.env.ANTIPHONY_APP_WEBHOOK_SECRETS,
): Map<string, WebhookConfig> {
    if (cached && cached.urlsRaw === urlsRaw && cached.secretsRaw === secretsRaw) {
        return cached.configs;
    }
    const configs = buildConfigs(urlsRaw, secretsRaw);
    cached = { urlsRaw, secretsRaw, configs };
    return configs;
}

/** Resolve one tenant's webhook config, or undefined (no config / partial → no push). */
export function resolveWebhookConfig(originAppId: string): WebhookConfig | undefined {
    return webhookConfigs().get(originAppId);
}

function buildConfigs(
    urlsRaw: string | undefined,
    secretsRaw: string | undefined,
): Map<string, WebhookConfig> {
    const urls = parsePairs(urlsRaw, 'ANTIPHONY_APP_WEBHOOK_URLS', validateUrl);
    const secrets = parsePairs(secretsRaw, 'ANTIPHONY_APP_WEBHOOK_SECRETS', validateSecret);

    const configs = new Map<string, WebhookConfig>();
    // Union of both key sets, so a tenant present in only one is caught rather
    // than silently missed by iterating just one map.
    for (const appId of new Set([...urls.keys(), ...secrets.keys()])) {
        const url = urls.get(appId);
        const secret = secrets.get(appId);
        if (url && secret) {
            configs.set(appId, { url, secret });
            continue;
        }
        logger.error(
            { appId, hasUrl: !!url, hasSecret: !!secret },
            '[webhook-config] tenant has webhook url or secret but not both — no webhooks will be sent for it; set both or neither',
        );
    }
    return configs;
}

/**
 * Parse `appId:value` comma-separated pairs, splitting on the FIRST colon only —
 * the value (a URL, `https://host:port/path`, or a secret) may itself contain
 * colons, so the app id is the head and the value is the remainder. Malformed or
 * invalid entries drop with an error log (fail-closed for that tenant). Mirrors
 * `parseAppDids`.
 */
function parsePairs(
    raw: string | undefined,
    varName: string,
    validate: (value: string, appId: string) => boolean,
): Map<string, string> {
    const out = new Map<string, string>();
    if (!raw || !raw.trim()) return out;
    for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        const appId = sep > 0 ? trimmed.slice(0, sep).trim() : '';
        const value = sep > 0 ? trimmed.slice(sep + 1).trim() : '';
        if (!appId || !value) {
            logger.error({ entry: trimmed.slice(0, 24) }, `[webhook-config] malformed ${varName} entry; ignoring`);
            continue;
        }
        if (!validate(value, appId)) continue;
        out.set(appId, value);
    }
    return out;
}

/** A webhook URL must parse and be http(s) — anything else has nowhere valid to POST. */
function validateUrl(value: string, appId: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        logger.error({ appId }, '[webhook-config] webhook url is not a valid URL; ignoring entry');
        return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        logger.error({ appId, protocol: parsed.protocol }, '[webhook-config] webhook url must be http(s); ignoring entry');
        return false;
    }
    return true;
}

/** A secret only has to be non-empty; the trim in `parsePairs` already enforces that. */
function validateSecret(_value: string, _appId: string): boolean {
    return true;
}
