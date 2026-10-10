# Specs

Design specs and decision records for Antiphony. Each spec carries its own
**Status** line at the top; this index summarises it. Status here means:

- **implemented** — the design is in the tree and deployed; the spec is now the
  standing description or decision record.
- **partial** — some phases are built, the rest is still proposal. The spec says
  which.
- **proposal** — nothing (or almost nothing) is built yet.
- **archived** — kept for the record; do not read as a description of the tree.

When a spec's status changes, update its Status line and this table together.

| Spec | Summary | Status |
| :--- | :--- | :--- |
| [`api-versioning.md`](api-versioning.md) | Two version axes: the `/api/v1/` URL major and the `0.x` contract version in `OPENAPI_INFO`; what counts as breaking before 1.0. | implemented |
| [`atproto-authority-model.md`](atproto-authority-model.md) | App-as-repo-owner (Model B): records are authored under a pinned tenant app DID. The 2026-09-24 update (spaces, minted DIDs, attribution) is still to be built. | partial |
| [`core-bff-boundary.md`](core-bff-boundary.md) | What belongs in the core versus a consuming app's BFF, the join contract between them, and where each removed route went. | implemented |
| [`core-surface.md`](core-surface.md) | The public API is posts and audio only; author identity is carried as opaque references, never hydrated profiles. | implemented |
| [`did-plc-and-multi-did-tenancy.md`](did-plc-and-multi-did-tenancy.md) | `did:plc` tenant DIDs and more than one DID per tenant. Phase 1 (the pin validator accepts `did:plc`) is built; later phases are proposal. | partial |
| [`docs-content-scope.md`](docs-content-scope.md) | Which content belongs on docs.antiphony.dev (protocol and infrastructure) and which belongs to apps built on it. | implemented |
| [`enrichment-pipeline.md`](enrichment-pipeline.md) | The four processing stages (denoise, trim, transcribe, waveform), their ordering, durable dispatch, and the provider seam. | implemented |
| [`enrichment-webhooks.md`](enrichment-webhooks.md) | Signed outbound webhooks to the tenant's BFF each time an enrichment stage settles. | implemented |
| [`mp3-rendition-stage.md`](mp3-rendition-stage.md) | `apps/audio-rendition` (ffmpeg on Cloud Run) and on-demand renditions via `GET /api/v1/audio?format=mp3`; also backs trim and waveform. | implemented |
| [`provider-selection.md`](provider-selection.md) | Per-stage provider selection and a model-config convention for enrichment vendors. | implemented |
| [`service-auth.md`](service-auth.md) | Service-token bearer auth with asserted acting actors; signed service auth (`X-Antiphony-Service-Auth`) is verified but observation-only. | implemented (bearer); signed auth partial |
| [`spaces.md`](spaces.md) | Implementation plan for atproto spaces, with Bardcast campaigns as the first consumer. | proposal |
| [`tenancy-stats.md`](tenancy-stats.md) | A read-only `GET /api/v1/stats` route for corpus-level questions about the calling tenancy. | proposal |
| [`tenant-onboarding.md`](tenant-onboarding.md) | Runbook for connecting a new tenant: service token, app-DID pin, and verification. | implemented |
| [`xrpc-and-atproto-lex-strategy.md`](xrpc-and-atproto-lex-strategy.md) | The `/xrpc` inbound adapter and how upstream `@atproto/lex` tooling is used (a CI validation oracle, not a runtime replacement). Phase 1 built; phases 2–3 proposal. | partial |

## Archive

Completed plans and point-in-time audits, kept for the reasoning behind
decisions rather than as descriptions of the current tree.

| Spec | Summary | Status |
| :--- | :--- | :--- |
| [`archive/cloudflare-migration.md`](archive/cloudflare-migration.md) | Assessment of moving core-api from Cloud Run, Firestore and Firebase Storage to Workers, Neon, R2 and Queues. The migration has since happened. | archived |
| [`archive/docs-audit-2026-07-25.md`](archive/docs-audit-2026-07-25.md) | Audit of the public docs site against the code; every finding was fixed. | archived |
| [`archive/enrichment-pipeline-plan.md`](archive/enrichment-pipeline-plan.md) | Step-by-step execution record for the enrichment pipeline. | archived |
