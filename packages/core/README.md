# @vox-pop/core

**Status:** scaffolded, empty. Phase 2 not yet begun.

The open-core tier of Vox Pop. Per [`specs/decoupling-migration.md`](../../specs/decoupling-migration.md), this package is intended to hold:

- Prompts, replies, users, auth primitives, signed-URL logic
- Portable service interfaces (repositories, verifiers, stores)
- AT Protocol lexicon alignment types (when they land)

And is intended to **exclude**:

- Firebase SDK imports (both `firebase` and `firebase-admin`)
- Transcription, denoising, scoring, SIP, or any hosted-service concern
- Next.js-specific code

## Current state

Nothing has moved in yet. The package exists so the workspace boundary is real at the build-tool level — new code and migrations can target `@vox-pop/core` immediately rather than "the eventual core package."

## Rules when code starts migrating

1. **No `firebase` or `firebase-admin` imports in this package.** The `package.json` intentionally omits them; if a port needs them, it's evidence that the port isn't complete — the Firebase-backed implementation should live in `apps/web/` (or `packages/hosted/` once that exists) as an adapter binding.

2. **Pattern to follow:** see `apps/web/src/services/hydration-dependencies.ts` for the template. A portable service defines a `...Dependencies` interface; the Firebase-backed implementation lives outside core and is injected at construction.

3. **Shared types** stay in `@vox-pop/shared`. Don't duplicate them here.
