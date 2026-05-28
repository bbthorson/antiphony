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
