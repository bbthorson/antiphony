import { readFileSync } from 'node:fs';
import { validateAllPins, checkTenantRegistryDrift } from '../src/lib/app-did.js';
import { parseAppTokens } from '../src/middleware/service-auth.js';

/**
 * Prove every configured app-DID pin, as a DEPLOY-TIME gate.
 *
 * ## Mechanism 1 of the boot-gate replacement
 *
 * The property the old boot gate served well is **deploy-time correctness**:
 * the pins we are about to ship are valid. A typo in `ANTIPHONY_APP_DIDS`, a
 * DID with no `#atproto_pds`, a host mismatch — these are high-probability
 * failures and every one of them is knowable before a single request.
 *
 * Running that check here is strictly better than running it at boot, which is
 * where it lives today:
 *
 *   - **It fails before anything ships.** A bad pin used to fail the deploy
 *     *after* the image was built and the revision pushed, which is the entire
 *     reason `deploy.yml` carried a no-traffic → smoke-test → promote sequence.
 *     That apparatus existed to contain a failure this step prevents, and it
 *     went with the Cloud Run runtime.
 *   - **It has somewhere to report to.** A boot failure is a container exit
 *     code; this is a workflow step with the reason in its log.
 *
 * `checkTenantRegistryDrift` moves here for the same reason. It compares two
 * env vars — tenants with a token but no pin, and the reverse — which is config
 * drift, fully knowable at deploy time, and it has no business being a runtime
 * warning nobody reads.
 *
 * ## What this deliberately does NOT do
 *
 * It does not replace the runtime check. Deploy-time correctness and **ongoing
 * custody** are separate properties, and the boot gate only ever served the
 * second by accident — a process up for thirty days answers with a thirty-day
 * old proof. Ongoing custody is `ensureTenantPin` on the request path and the
 * hourly drift cron. This step is about the pins in the commit.
 *
 * ## Usage
 *
 * Reads the pins from `apps/core-api/wrangler.jsonc` — the config the deploy
 * actually applies — with `ANTIPHONY_APP_DIDS` / `ANTIPHONY_PDS_HOST` in the
 * environment taking precedence for a one-off check against something else.
 * Exits non-zero on any pin that cannot be proven; drift is reported and does
 * NOT fail, which matches the runtime's own judgement that an app may
 * legitimately authenticate without touching the posts surface.
 *
 *     npm run validate:pins -w @antiphony/core-api
 */

/**
 * Strip comments from JSONC, so the Worker config can be read as JSON.
 *
 * `wrangler.jsonc` is the single source of truth for the tenant registry, and
 * this gate has to read the same file the deploy applies or it is proving a
 * different config than the one that ships. A naive comment strip would be
 * wrong here — the file is full of `https://` inside string values — so this
 * tracks whether it is inside a string, and honours escapes.
 */
function stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (c === '\n') { inLine = false; out += c; }
            continue;
        }
        if (inBlock) {
            if (c === '*' && next === '/') { inBlock = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            // A backslash escapes the next character, including a quote.
            if (c === '\\') { out += text[++i] ?? ''; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        out += c;
    }
    return out;
}

/** The `vars` block of the Worker config, or nothing if it cannot be read. */
function workerVars(): Record<string, string> {
    const path = new URL('../wrangler.jsonc', import.meta.url);
    try {
        const parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
        return (parsed.vars ?? {}) as Record<string, string>;
    } catch (err) {
        console.warn(`[validate-pins] could not read wrangler.jsonc: ${(err as Error).message}`);
        return {};
    }
}

// The environment wins, so a caller can point this at a config that is not the
// committed one; otherwise read the Worker config that is about to ship.
const vars = workerVars();
const pdsHost = (process.env.ANTIPHONY_PDS_HOST ?? vars.ANTIPHONY_PDS_HOST)?.trim();
const raw = (process.env.ANTIPHONY_APP_DIDS ?? vars.ANTIPHONY_APP_DIDS)?.trim();

if (!raw) {
    // An empty pin set is valid — a deployment with no tenants onboarded yet.
    // Worth saying out loud rather than passing silently, because the state it
    // is indistinguishable from is "the var did not make it into this
    // environment", which is a much worse thing to discover at runtime.
    console.warn(
        '[validate-pins] ANTIPHONY_APP_DIDS is empty or unset — nothing to prove. This is valid for a deployment with no tenants, and a misconfiguration for any other.',
    );
    process.exit(0);
}

if (!pdsHost) {
    console.warn(
        '[validate-pins] ANTIPHONY_PDS_HOST unset — checking only that each DID document exists and names an #atproto_pds endpoint, NOT that it points at us. That is the weaker half of the custody claim.',
    );
}

try {
    const snapshot = await validateAllPins({ expectedPdsHost: pdsHost, raw });
    console.log(
        `[validate-pins] proved custody for ${snapshot.size} tenant(s): ${[...snapshot.keys()].join(', ')}`,
    );

    // Reported, not fatal — the same call the runtime makes, and the same
    // judgement: a tenant in one registry and not the other is a
    // misconfiguration worth surfacing, but one tenant's gap must not block
    // everyone else's deploy.
    //
    // Skipped entirely when the token registry is absent. Tokens are a SECRET
    // and may legitimately not be in an environment that has the (public) DIDs
    // — and comparing against an empty set would report EVERY pin as
    // unreachable, which is exactly the noise that teaches people to ignore
    // this line.
    if (process.env.ANTIPHONY_APP_TOKENS?.trim()) {
        const drift = checkTenantRegistryDrift(parseAppTokens().map((a) => a.appId));
        if (drift.tokensWithoutPin.length || drift.pinsWithoutToken.length) {
            console.warn('[validate-pins] tenant registry drift:', drift);
        }
    } else {
        console.log('[validate-pins] ANTIPHONY_APP_TOKENS absent — skipping the drift check');
    }
} catch (err) {
    console.error(`[validate-pins] FAILED — not deploying.\n${(err as Error).message}`);
    process.exit(1);
}
