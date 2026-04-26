// @vox-pop/core — the open-core tier.
//
// This package is intentionally empty today. It exists as the structural home
// for code that will migrate from `apps/web/src/services/*` during Phase 2 of
// the decoupling migration. See `specs/decoupling-migration.md`.
//
// Guardrails:
//   - MUST NOT add runtime dependencies on `firebase` or `firebase-admin`.
//     Those live in `packages/hosted/` (when it exists) or in `apps/web/` as
//     adapter bindings. Core defines the portable interfaces; Firebase-backed
//     implementations live elsewhere.
//   - When a service ports in, it brings its `...Dependencies` interface with
//     it (see `apps/web/src/services/hydration-dependencies.ts` for the
//     precedent). The Firebase-backed implementation stays in `apps/web/` or
//     moves to `packages/hosted/` — never here.
//
// The Phase 4c AT Protocol lexicon transformation is the first real export
// from this package — pure record-to-lexicon mapping with no Firebase or
// SDK dependency. See `lexicons/README.md` at the repo root.
export * from './services/atproto-lexicon';
