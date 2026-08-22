# `@antiphony/audio-rendition`

Derives renditions of Antiphony audio blobs — today `mp3`, for callers that
cannot decode webm/opus — and writes them to R2 where the audio proxy serves
them from.

Three routes, two jobs:

| Route | Job | Shape |
| :--- | :--- | :--- |
| `POST /render` | **Delivery** — derive an `mp3` for a caller that cannot decode webm/opus | `{originAppId, cid, format}` in, object path out; both ends talk to R2 |
| `POST /trim` | **Ingest** — trim leading/trailing silence and re-encode | audio in, audio out |
| `POST /waveform` | **Ingest** — render-ready peaks | audio in, numbers out |

All three are system-authed with the same `SYSTEM_AUTH_TOKEN` core-api holds.

The shapes differ deliberately, and the reason is in `app.ts` § Why `/trim` and
`/waveform` take bytes: the ingest ports in `@antiphony/core` are `bytes in,
result out`, and `AudioProcessingService` owns the storage either side because
the derived CID goes into a record and is therefore Antiphony's to compute.

## Why a separate service at all

It shells out to `ffmpeg`, and a Workers runtime cannot spawn a subprocess.
That is the one requirement Cloudflare's serverless runtime cannot satisfy at
any amount of effort, which is why `specs/archive/cloudflare-migration.md` § The ffmpeg
problem chose "one small container" over Cloudflare Containers (a new runtime
and deploy system) and over `ffmpeg.wasm` (well past the Worker bundle limit
before you reach its thread requirements).

That applies to core-api's `trim` and `waveform` stages too — they used to
`execFile` ffmpeg in-process on Cloud Run, and briefly resolved **unavailable**
on Workers. They live here now, so both work again. Their availability in
core-api is `is a transcode backend configured` rather than `is a binary
present`, which is the honest question on a runtime that cannot have the binary.

## Adopted from Vox Pop, and mostly by deletion

This began as `@vox-pop/audio-rendition`. Antiphony owns the blob, canonical and
derived, so the service that derives from it belongs on this side of the seam —
and moving it here let most of it be **deleted rather than ported**.

The Vox Pop version takes a source **URL** from an anonymous caller. That single
fact is what forced everything below, and none of it survives the move:

| Gone | Why it existed | Why it does not need to |
| :--- | :--- | :--- |
| `parseSourceUrl` | Recover a cache key from a caller-supplied URL | The caller passes `{originAppId, cid}`; we compose the path |
| `ALLOWED_SOURCE_HOSTS` | SSRF boundary — the handler fetched a caller-named URL | Nothing fetches a caller-named URL |
| `ALLOWED_SOURCE_BUCKET` | Cache-poisoning defence (see below) | There is no attacker-authored source to pin against |
| "the source must already be readable" | Rate-limit-by-signature: a caller could only transcode bytes they could already fetch | The service is system-authed; the public surface is the audio proxy |
| `buildContentDisposition` | Creator downloads needed a named attachment | This service writes to R2 and returns; it serves no browser |

The poisoning defence is the one worth spelling out, because it is subtle and
the reason the bucket pin was load-bearing rather than decorative. That service
reads its cache key off the source URL's own path — so a caller who can name the
path can name the cache key. Anyone can create a public
`storage.googleapis.com` bucket and put an object in it at
`blobs/voxpop/{victim CID}`. Pointing `src` at that passes a host-only check,
transcodes attacker bytes, and writes them where the victim's rendition should
be — served `immutable` from then on. The result is arbitrary audio played to
the victim's callers.

Here the path is composed from a tenant-scoped CID the service resolved itself.
There is nothing to pin.

It also removes the coupling that version's README flags as a known landmine:
`ALLOWED_SOURCE_HOSTS` hardcoded to `storage.googleapis.com` while Antiphony's
blobs move to R2. That would have been a code change on a live telephony path.

## `/render` returns a path, not bytes

It reads the source from R2, transcodes, writes the rendition to R2, and answers
with the object path.

That is deliberate: the alternative is passing the audio through the Worker in
both directions, and a Worker isolate has 128MB while `readBlobBytes`
materialises a whole blob. Having both ends talk to R2 directly keeps the
transcoded bytes out of the Worker entirely — the Worker's job on a miss is to
ask, then stream from R2 exactly as it would on a hit.

The ingest routes cannot do that, and the constraint is the ports rather than a
preference — see the table above and `app.ts` for the argument. `/waveform` is
the cheap half either way: only the request carries audio.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Injected by Cloud Run |
| `SYSTEM_AUTH_TOKEN` | — | **Required.** The same shared secret core-api's `/system/*` routes take. Without it the service refuses every request rather than serving unauthenticated |
| `ANTIPHONY_R2_BUCKET` | `antiphony-r2-bucket` | Holds both `blobs/` and `renditions/` |
| `R2_ACCOUNT_ID` | — | **Required.** Cloudflare account id, for the S3 endpoint |
| `R2_ACCESS_KEY_ID` | — | **Required.** R2 S3 API key |
| `R2_SECRET_ACCESS_KEY` | — | **Required.** R2 S3 API secret |
| `LOG_LEVEL` | `info` in production | |
| `COMMIT_SHA` / `BUILD_TIME` | `dev` / null | Stamped by the deploy workflow; reported by `/health` |

**This is the one place a stored R2 credential is unavoidable.** Everywhere else
in Antiphony, R2 access is a Worker binding and needs no key at all — which is
why the blob store has no signing code. This service runs outside the Workers
runtime and cannot hold a binding, so it gets S3 API credentials. See
`specs/archive/cloudflare-migration.md` § Secrets, which names this as the exception.

Scope the key to the one bucket. It needs `blobs/` read and `renditions/` write;
it has no reason to read `renditions/` back beyond the existence check, and no
reason to touch `blobs/` at all except to read a source.

## Local development

```bash
npm run dev -w @antiphony/audio-rendition     # tsx watch, binds :8080
npm run test -w @antiphony/audio-rendition
```

`npm run dev` needs a local `ffmpeg` (`brew install ffmpeg` / `apt install
ffmpeg`). The startup probe tells you whether you have one — worth reading,
because the container has ffmpeg and your machine might not, and the failure is
otherwise invisible until the first cache miss.

`ffmpeg` was never a declared dependency in the Vox Pop version and worked only
because Google's Node runtime image happened to ship the binary. `node:22-slim`
does not, so the Dockerfile installs it and **asserts it at build time**, and
`src/index.ts` probes again at startup. Belt and braces on purpose: the build
check catches a bad image, the startup probe catches a good image run somewhere
unexpected.
