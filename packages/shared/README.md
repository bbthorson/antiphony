# @antiphony/shared

Shared types, Zod schemas, and request/response codecs for [Antiphony](https://github.com/bbthorson/antiphony) — open infrastructure and an AT Protocol lexicon for audio call-and-response.

This is the contract package: the same Zod schemas that validate the wire format in `apps/core-api`, mirror the `dev.antiphony.*` lexicons, and type any client built on the public API. If you're building against Antiphony, this is what you import.

Docs: **<https://docs.antiphony.dev>** — start with [the lexicons](https://docs.antiphony.dev/lexicons/overview/).

## Install

```bash
npm install @antiphony/shared zod
```

`zod` is the only runtime dependency and the peer of every validation schema.

## Dual ESM/CJS

Ships both ESM and CommonJS builds with correct type resolution under `node16`/`nodenext` and bundlers (verified with [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)). `import` and `require` both resolve to the right artifact.

## Exports

```ts
import { AudioPostRecordSchema, AudioPostViewSchema } from '@antiphony/shared';
```

The root re-exports the most-used pieces (records, views, audio types, API types, codecs, NSIDs, errors, utils, observability). Granular subpaths are available too:

| Subpath | What's in it |
| :--- | :--- |
| `@antiphony/shared` | The common surface: records, views, audio + API types, `api-codecs`, `nsid`, `errors`, `utils`, `observability`. |
| `@antiphony/shared/api-codecs` | Request/response Zod codecs for the REST surface. |
| `@antiphony/shared/nsid` | The `dev.antiphony.*` NSID constants. |
| `@antiphony/shared/errors` | Shared error types and helpers. |
| `@antiphony/shared/utils` | Pure shared utilities (projection/date/sanitization helpers). |
| `@antiphony/shared/observability` | Logging/error-reporting helpers (`./observability/report-error` for just the reporter). |
| `@antiphony/shared/types/*` | Individual type modules: `records`, `views`, `audio`, `blob`, `api`, `channels`, `storage`. |

## The records this models

- **`dev.antiphony.audio.post`** — the single canonical content record. A post without a `reply` is a prompt; with a `reply` it's a reply.
- **`dev.antiphony.embed.audio`** — the audio attachment (stored record + hydrated view with a signed playback URL).
- **`dev.antiphony.audio.transcript`** — platform-enrichment transcript, lifted into the embed view at read time.
- **`dev.antiphony.actor.profile`** — the actor profile.

See the [lexicon reference](https://docs.antiphony.dev/lexicons/overview/) for the full contract.

## License

MIT
