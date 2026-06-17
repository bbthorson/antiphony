/**
 * Public-surface extraction — the Plan A (A5) contract guard.
 *
 * The "surface" is the SET of public endpoints (path + method), nothing more.
 * `scripts/generate-openapi.ts` writes it to `openapi.surface.json`;
 * `openapi-surface.test.ts` rebuilds it from the live routes and fails on any
 * drift, so adding / removing / renaming a public endpoint is a deliberate,
 * reviewed act that must update the snapshot in the same PR.
 *
 * Scope: this guards the surface *shape* (which endpoints exist), NOT the
 * field-level contract detail within an endpoint (a `maxLength` shrinking, a
 * field becoming required). That class of drift belongs to Plan D (versioning
 * `@vox-pop/shared`). See `specs/plan-a-core-api-contract.md`.
 */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

type OpenAPIDocLike = { paths?: Record<string, Record<string, unknown> | undefined> } | null | undefined;

/** Returns the sorted `"METHOD /path"` set for an OpenAPI document. */
export function extractSurface(doc: OpenAPIDocLike): string[] {
    const endpoints: string[] = [];
    for (const [path, item] of Object.entries(doc?.paths ?? {})) {
        if (!item) continue;
        for (const method of HTTP_METHODS) {
            if (item[method]) endpoints.push(`${method.toUpperCase()} ${path}`);
        }
    }
    return endpoints.sort();
}
