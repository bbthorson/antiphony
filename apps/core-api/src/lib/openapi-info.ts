/**
 * Shared `info` block for the generated OpenAPI document.
 *
 * Used by both the runtime `/openapi.json` endpoint in `src/app.ts`
 * and the build-time `scripts/generate-openapi.ts` runner. Keeping it
 * in one place means the version, title, and the markdown narrative
 * (Auth + envelope conventions) stay in sync.
 */
export const OPENAPI_INFO = {
    title: 'Vox Pop Core API',
    version: '0.1.0',
    description: [
        'Open-source REST surface for Vox Pop — users, prompts, replies, and the auth surface that links them.',
        '',
        '## Authentication',
        '',
        'Every authenticated endpoint accepts a bearer token via the `Authorization: Bearer <token>` header. Two token types are accepted interchangeably:',
        '',
        '- **Firebase ID token** — issued by the Firebase Auth client SDK. Short-lived (~1 hour); refresh client-side.',
        '- **Firebase session cookie** — issued by the hosted dashboard via `POST /api/v1/auth/session` (apps/web only; per-origin Set-Cookie semantics). Longer-lived; useful for server-rendered clients.',
        '',
        'Both verify against the same Firebase project. Public endpoints accept missing/invalid tokens but project to the public view shape.',
        '',
        '## Envelope',
        '',
        'Every JSON response wraps its payload: `{ success: true, data: T }` on success, `{ success: false, error: { message, code?, issues? }, requestId }` on failure. Pagination cursors live inside `data.nextCursor`.',
    ].join('\n'),
} as const;

/**
 * The approved tag set for the public contract — the single source of truth
 * for "what is public" (Plan A, A4). A route belongs in the documented surface
 * **iff** it is instrumented via `app.openapi(createRoute(...))` and carries one
 * of these tags. Adding a tag here is a deliberate widening of the contract;
 * do not introduce a tag without a corresponding surface review.
 *
 * Each entry maps to a class in the design rule (primitive / query /
 * public-projection); compositions and app-coupled routes stay on plain `Hono`
 * and never appear here. See `specs/plan-a-core-api-contract.md`.
 */
export const OPENAPI_TAGS = [
    { name: 'Users', description: 'User primitives, the viewer\'s own profile, and public identity projections (profiles, handle resolution).' },
    { name: 'Prompts', description: 'Prompt primitives — create, read, update status, and the public prompt projection.' },
    { name: 'Replies', description: 'Reply primitives plus the cross-prompt feed and transcription search queries.' },
    { name: 'Audio', description: 'Audio storage primitives — the signed-URL proxy and the authenticated / anonymous upload endpoints.' },
    { name: 'Auth', description: 'Identity-linking primitives (AT Protocol connect/disconnect).' },
    { name: 'Connectors', description: 'Connector control plane — uniform per-connector config, status, and enable/disable (settings opaque, secrets by reference).' },
] as const;
