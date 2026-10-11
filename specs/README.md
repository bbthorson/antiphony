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
| [`atproto-authority-model.md`](atproto-authority-model.md) | Who keeps each record: authority is custody, people are facets, orgs and tenants get minted DIDs, and a space record's author segment is its authority's DID (D1–D8). History in `archive/`. | decided; partial |
| [`core-bff-boundary.md`](core-bff-boundary.md) | What belongs in the core versus a consuming app's BFF, the join contract between them, and where each removed route went. | implemented |
| [`core-surface.md`](core-surface.md) | The public API is posts and audio only; author identity is carried as opaque references, never hydrated profiles. | implemented |
| [`cross-repo-design.md`](cross-repo-design.md) | How Antiphony, Vox Pop and Bardcast fit together: REST for tenants and XRPC for the protocol, per-prompt reply spaces, the author segment, the Phase 3 plan, and shared code to move into Antiphony. | decided |
| [`did-plc-and-multi-did-tenancy.md`](did-plc-and-multi-did-tenancy.md) | `did:plc` tenant DIDs and more than one DID per tenant. Phase 1 (the pin validator accepts `did:plc`) is built; later phases are proposal. | partial |
| [`docs-content-scope.md`](docs-content-scope.md) | Which content belongs on docs.antiphony.dev (protocol and infrastructure) and which belongs to apps built on it. | implemented |
| [`enrichment-pipeline.md`](enrichment-pipeline.md) | The four processing stages (denoise, trim, transcribe, waveform), their ordering, durable dispatch, and the provider seam. | implemented |
| [`enrichment-webhooks.md`](enrichment-webhooks.md) | Signed outbound webhooks to the tenant's BFF each time an enrichment stage settles. | implemented |
| [`mp3-rendition-stage.md`](mp3-rendition-stage.md) | `apps/audio-rendition` (ffmpeg on Cloud Run) and on-demand renditions via `GET /api/v1/audio?format=mp3`; also backs trim and waveform. | implemented |
| [`provider-selection.md`](provider-selection.md) | Per-stage provider selection and a model-config convention for enrichment vendors. | implemented |
| [`service-auth.md`](service-auth.md) | Service-token bearer auth with asserted acting actors; signed service auth (`X-Antiphony-Service-Auth`) is verified but observation-only. | implemented (bearer); signed auth partial |
| [`spaces.md`](spaces.md) | atproto spaces: data model and URIs (Phase 1) and the tenant API with signed playback (Phase 2) are built; the protocol surface (Phase 3) and Bardcast (Phase 4) are not. Revised 2026-10-11. | partial |
| [`tenancy-stats.md`](tenancy-stats.md) | A read-only `GET /api/v1/stats` route for corpus-level questions about the calling tenancy. | proposal |
| [`tenant-onboarding.md`](tenant-onboarding.md) | Runbook for connecting a new tenant: service token, app-DID pin, and verification. | implemented |
| [`xrpc-and-atproto-lex-strategy.md`](xrpc-and-atproto-lex-strategy.md) | The `/xrpc` adapter (five `dev.antiphony.audio.*` methods) and upstream lexicon tooling as a CI oracle. XRPC-first at 1.0; see `xrpc-surface.md`. | partial |
| [`xrpc-surface.md`](xrpc-surface.md) | XRPC as Antiphony's whole API at 1.0: the method inventory, auth tiers, errors, upload and playback, rollout, the open XRPC decisions (D-1 to D-14) and the wider strategy gaps. | proposal |

## Archive

Completed plans and point-in-time audits, kept for the reasoning behind
decisions rather than as descriptions of the current tree.

| Spec | Summary | Status |
| :--- | :--- | :--- |
| [`archive/atproto-authority-model-history.md`](archive/atproto-authority-model-history.md) | The authority model's evolution from 2026-07-03 to 2026-10-07: why Model B, why `did:web`, why not a PDS, why spaces were first deferred. | archived |
| [`archive/cloudflare-migration.md`](archive/cloudflare-migration.md) | Assessment of moving core-api from Cloud Run, Firestore and Firebase Storage to Workers, Neon, R2 and Queues. The migration has since happened. | archived |
| [`archive/docs-audit-2026-07-25.md`](archive/docs-audit-2026-07-25.md) | Audit of the public docs site against the code; every finding was fixed. | archived |
| [`archive/enrichment-pipeline-plan.md`](archive/enrichment-pipeline-plan.md) | Step-by-step execution record for the enrichment pipeline. | archived |
