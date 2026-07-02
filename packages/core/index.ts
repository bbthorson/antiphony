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
// AuthPort — pure contract (Zod schemas + interface + Result type); no
// implementation, no runtime dependency on any auth backend. Adapters
// (Firebase / Stub / future DID) live in consuming apps and satisfy this port.
export * from './ports/auth-port';
