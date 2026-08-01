// @antiphony/core — the open-core tier.
//
// Core defines the portable domain services + ports (interfaces); the
// Firebase-backed bindings live in `apps/core-api/src/adapters/outbound/`.
//
// Guardrails:
//   - MUST NOT add runtime dependencies on `firebase` or `firebase-admin`.
//     Core defines the portable interfaces; Firebase-backed implementations
//     live in the outbound adapters, never here.
//   - When a service needs a backend, it brings its `...Dependencies` port
//     interface with it; the concrete binding stays in the adapter layer.
//
// This file deliberately re-exports NOTHING. Every consumer imports the
// subpath it actually needs — `@antiphony/core/services/audio-processing`,
// `@antiphony/core/ports/logger`, and so on — which keeps the dependency
// arrows legible and means adding a service here can't silently widen what
// the package hands out.
//
// It previously exported `./ports/auth-port`, a contract whose only
// implementations lived in a consuming app that has since moved off this
// repo. Since nothing imports the bare `@antiphony/core` specifier, that
// export — and the 700 lines behind it — reached no one.
export {};
