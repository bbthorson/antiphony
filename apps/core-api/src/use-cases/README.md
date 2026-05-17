# Use Cases (Application Layer)

The orchestration layer between the inner domain (`packages/core/services/`)
and the outer adapters (`src/adapters/inbound/`, `src/adapters/outbound/`).

A use case composes multiple domain services + ports into a single
caller-facing operation. Examples of work that belongs here:

- **Cross-resource composition** — assembling a feed view by reading
  canonical replies + merging enrichments + applying owner-aware visibility.
- **Multi-step transactions** — onboarding a new user (write user record →
  reserve handle → grant default org membership), where rollback semantics
  matter.
- **Channel-credential reconciliation** — claiming an orphan reply when a
  pre-account caller (phone, anonymous session, oEmbed source URL) finally
  creates a Vox Pop account.

What does NOT belong here:

- **Single-service calls** — if it's a thin pass-through to one
  `packages/core/services/*` method, keep it inline in the route handler.
  Don't create a use case just to wrap one service call.
- **Pure domain logic** — that lives in `packages/core/services/`. Use
  cases call into those services; they don't reimplement them.
- **Adapter wiring** — composition root logic stays in
  `src/adapters/outbound/firebase/core-services-firebase.ts`.

The layer is currently empty. New use cases land here as cross-resource
orchestration is identified — e.g. when the reply-feed orchestration
(currently in apps/web's `server-proxy-http.ts` as a thin
`coreApiFetch` wrapper) eventually moves server-side, or when the
channel-reply capture pattern for the Reader/Replier channels (per the
plan file) needs a shared home.
