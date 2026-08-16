import { validateAllPins } from '../app-did.js';

/**
 * Seed the validated app-DID snapshot for a test, with no network I/O.
 *
 * ## Why so many suites need this now
 *
 * Custody used to be proven once, at boot, by `index.ts` — so `app()` produced
 * a router that assumed the snapshot already existed, and only suites reaching
 * `getAppDid` (post hydration) had to populate it. The Workers replacement
 * proves custody per tenant inside `requireAuth` / `requireServiceToken`, which
 * means EVERY gated route now touches the pin registry, and a suite with no
 * pins configured gets a 503 rather than the response it is asserting on.
 *
 * That is the correct behaviour — a tenant with a credential and no pin can
 * authenticate and then fail every post operation, which is exactly what the
 * registry-drift warning has always said — but it is not what those suites are
 * testing. Seeding here keeps them about their own subject.
 *
 * The snapshot is populated through the real `validateAllPins` against a stub
 * `fetch`, rather than by reaching into module state. That keeps this honest:
 * if the shape of a validated pin changes, this fixture changes with it instead
 * of quietly producing something the production path would reject.
 *
 * `validatedAt` lands at `Date.now()`, so `ensureTenantPin` finds the entry
 * inside its freshness window and returns without resolving anything.
 */
export async function seedValidatedPins(
    pins: Record<string, string>,
    pdsEndpoint = 'https://api.antiphony.dev',
): Promise<void> {
    const raw = Object.entries(pins)
        .map(([appId, did]) => `${appId}:${did}`)
        .join(',');

    await validateAllPins({
        raw,
        fetchImpl: (async (url: string) => {
            // Reflect the DID back out of the document URL, so one stub serves
            // however many tenants a suite seeds.
            const host = new URL(url).host;
            return {
                ok: true,
                json: async () => ({
                    id: `did:web:${host}`,
                    service: [
                        {
                            id: '#atproto_pds',
                            type: 'AtprotoPersonalDataServer',
                            serviceEndpoint: pdsEndpoint,
                        },
                    ],
                }),
            };
        }) as unknown as typeof fetch,
    });
}
