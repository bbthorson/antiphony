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

/**
 * Minimum webhook-signing-secret length — the same bar `ANTIPHONY_APP_TOKENS`
 * and `SYSTEM_AUTH_TOKEN` hold their secrets to.
 *
 * This key is the *only* thing standing between a receiver and a forged
 * stage-settled event: the receiver's whole trust decision is recomputing the
 * HMAC and comparing. A short key is brute-forceable offline from a single
 * captured delivery, which makes the signature decorative. Fail closed for that
 * tenant rather than push events it can't safely trust.
 */
const WEBHOOK_SECRET_MIN_LENGTH = 32;

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

/** Loopback hosts, where plaintext http is a local-development convenience rather than a wire risk. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A webhook URL must parse, be http(s), and — off loopback — be https.
 *
 * The payload names a tenant's post ids and processing outcomes, and the
 * signature that authenticates it travels in a header beside it. Over plaintext
 * both are readable and strippable in transit, so a non-loopback `http:` target
 * is refused rather than quietly downgraded. Loopback stays allowed so a
 * receiver can be developed against `http://localhost:8787`.
 */
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
    if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
        logger.error(
            { appId, hostname: parsed.hostname },
            '[webhook-config] webhook url must be https off loopback (the signature travels with the payload); ignoring entry',
        );
        return false;
    }
    return true;
}

/**
 * A signing secret must clear `WEBHOOK_SECRET_MIN_LENGTH`. Previously any
 * non-empty string passed, so a deployment could sign with four characters and
 * read as correctly configured — the one place in this codebase where a secret
 * had no strength floor.
 */
function validateSecret(value: string, appId: string): boolean {
    if (value.length < WEBHOOK_SECRET_MIN_LENGTH) {
        logger.error(
            { appId, minLength: WEBHOOK_SECRET_MIN_LENGTH, actualLength: value.length },
            '[webhook-config] webhook signing secret too short; ignoring entry (rotate to ≥32 chars)',
        );
        return false;
    }
    return true;
}
