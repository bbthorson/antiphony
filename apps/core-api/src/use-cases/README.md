# Use Cases (Application Layer)

The orchestration layer between the inner domain (`packages/core/services/`)
and the outer adapters (`src/adapters/inbound/`, `src/adapters/outbound/`).

A use case composes multiple domain services + ports into a single
caller-facing operation. Examples of work that belongs here:

- **Cross-resource composition** — assembling a feed view by reading
  canonical posts + merging enrichments (transcripts, processing state) +
  applying viewer-aware visibility.
- **Multi-step transactions with rollback semantics** spanning more than
  one service — e.g. registering an actor's DID and backfilling
  `authorDid` on their prior posts.

What does NOT belong here:

- **Single-service calls** — if it's a thin pass-through to one
  `packages/core/services/*` method, keep it inline in the route handler.
  Don't create a use case just to wrap one service call.
- **Pure domain logic** — that lives in `packages/core/services/`. Use
  cases call into those services; they don't reimplement them.
- **Adapter wiring** — composition root logic stays in
  `src/adapters/outbound/firebase/core-services-firebase.ts`.

The layer is currently empty — every route today is a thin pass-through to
one service, so nothing has needed cross-resource orchestration yet. New use
cases land here when that changes.
