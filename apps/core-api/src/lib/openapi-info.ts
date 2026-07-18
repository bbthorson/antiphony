/**
 * Shared `info` block for the generated OpenAPI document.
 *
 * Used by both the runtime `/openapi.json` endpoint in `src/app.ts`
 * and the build-time `scripts/generate-openapi.ts` runner. Keeping it
 * in one place means the version, title, and the markdown narrative
 * (Auth + envelope conventions) stay in sync.
 */
export const OPENAPI_INFO = {
    title: 'Antiphony Core API',
    version: '0.3.1',
    description: [
        'Open-source REST surface for Antiphony — a headless store for AT-Protocol-shaped audio posts plus audio storage/hygiene. It holds content, tenancy, and custody; user profiles live in the calling app (a BFF), not here.',
        '',
        '## Authentication',
        '',
        'The **service token is the only accepted credential**. Every caller is an application (a BFF) that authenticates with `Authorization: Bearer <service-token>`; the token identifies the app and establishes its tenancy (`originAppId`). Antiphony verifies no end-user identity tokens.',
        '',
        '- **Acting actor** — the app asserts which of its users is acting via `X-Antiphony-Acting-Actor: <actorId>` (+ optional `X-Antiphony-Acting-Actor-Did`). Required on writes and viewer-scoped reads; omit it for an anonymous, tenancy-scoped read.',
        '- **Reads are gated too** — every data route requires the service token so the credential always establishes *which* tenant is being read. The sole exception is the audio playback proxy (`GET /api/v1/audio`), which is capability-based: allowlisted, content-addressed paths resolved to short-lived signed URLs.',
        '',
        '## Envelope',
        '',
        'Every JSON response wraps its payload: `{ success: true, data: T }` on success, `{ success: false, error: { message, code?, issues? }, requestId }` on failure. Pagination cursors live inside `data.nextCursor`.',
    ].join('\n'),
} as const;

/**
 * The approved tag set for the public contract — the single source of truth
 * for "what is public". A route belongs in the documented surface **iff** it
 * is instrumented via `app.openapi(createRoute(...))` and carries one of
 * these tags. Adding a tag here is a deliberate widening of the contract;
 * do not introduce a tag without a corresponding surface review.
 *
 * Each entry maps to a class in the design rule (primitive / query /
 * public-projection); compositions and app-coupled routes stay on plain `Hono`
 * and never appear here.
 */
export const OPENAPI_TAGS = [
    { name: 'Posts', description: 'Antiphony canonical audio posts (`dev.antiphony.audio.post`) — create, read, list, and threaded replies with hydrated audio + lifted transcript.' },
    { name: 'Audio', description: 'Audio storage primitives — the capability-based signed-URL playback proxy and the service-token-gated upload endpoint.' },
] as const;
