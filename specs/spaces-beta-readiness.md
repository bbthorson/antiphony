# Spaces public beta readiness (December 1, 2026)

**Status:** plan, 2026-11-14 (Brad agreed the plan the same day). Step 1 is built. This spec
records the protocol's names as of the last alpha before the beta, and what Antiphony and its
tenants need done before and after the beta begins. Other specs that use older names point
here.

## What's happening

From [Getting ready for the Spaces public beta](https://atproto.com/blog/getting-ready-for-the-spaces-public-beta)
(2026-11-13) and the [alpha updates thread](https://discourse.atmosphere.community/t/atproto-spaces-alpha-updates/1129):

- **The public beta begins December 1.** The reference PDS and Bluesky's PDS fleet are updated
  at the same time. Blacksky, Eurosky, Northsky and selfhosted.social are adding support too.
  From then on, most atproto accounts can use a Spaces app, and protocol changes are managed as
  if production software depends on them.
- **Active `did:plc` accounts get a PLC update that adds a `kem` key** (`#atproto_kem`). That is
  the key Antiphony encapsulates a record MAC against, so ordinary users' records become
  readable with a verified MAC without anything on their side. `did:web` accounts, and DIDs
  that aren't hosted on an upgraded PDS, don't get one automatically.
- **Data on alpha PDSes won't migrate cleanly**, and `spaces-alpha.host.bsky.network` will be
  shut down. Don't keep anything there.
- **An official SDK and docs with sample code** are coming. `@atproto/lex-space` (published
  November 12) already does the whole credential exchange and MAC verification.
- **Promotion to end users starts in early 2027.** December is for developers.

## The URI format: `at:space/` (decided 2026-11-24)

Space URIs moved to their own form in the [2026-11-24 alpha](https://discourse.atmosphere.community/t/atproto-spaces-alpha-updates/1129/20)
([migration prompt](https://github.com/bluesky-social/atproto/blob/permissioned-data/alpha-migrations/prompt-11-24-26.md)):

```
at:space/{spaceDid}/{spaceType}/{skey}                                   a space (`space-ref`)
at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}   a record in it
```

in place of `at://{spaceDid}/space/{spaceType}/{skey}/…`. Public URIs keep `at://`, so flat
records are unaffected. Both DIDs must be DIDs, never handles, and only those two lengths are
valid. The alpha SDKs read the old form leniently and write only the new one. **At the beta the
old form stops parsing.**

**What Antiphony did (contract `0.11.0`, `@antiphony/shared` `0.16.0`).** It switched outright,
as decided on 2026-11-14 (before any kept recording), with no period of accepting both on input:

- **Emits only `at:space/`.** Post URIs (`buildRecordUri`, through `SpaceRef#recordUri`), space
  views (`spaceUri`), and the remote-space URI (`spaceUriOf`) all print the new form.
- **Accepts only `at:space/` as input.** `parsePostUri`, `parseRemotePostUri`,
  `parseRemoteSpaceUri`, `RemoteSpaceUriSchema` and `SpaceViewSchema` refuse the old form.
  `StrongRefSchema` admits both prefixes, because it also parses stored records (next point);
  the services check the shape they need.
- **Reads alpha-era record values leniently.** A record's StrongRefs and an enrichment's
  `subject` are sealed into its CID, so a space reply recorded before 11-24 names its parent in
  the old form for good. Those values go through `normalizeAtUri`
  (`packages/core/services/space-uri.ts`, over upstream's temporary `fromLegacySpaceUri`) before
  they are compared or used as keys: the thread-root check, the deletion walk, the parent
  context for `assess`, and the transcript and assessment maps.
- **Migration `0012_space_uri_form.sql`.** Rewrites the columns Antiphony writes itself
  (`deleted_posts.uri`, `remote_posts.uri`, `deleted_remote_posts.uri`), widens
  `remote_posts_uri_shape`, and redefines the generated `reply_parent_uri`, `reply_root_uri` and
  `subject_uri` columns to normalize, so every index holds the current form. Re-runnable: it only
  matches the old form. Record JSON is untouched.
- **Pins** moved to `0.0.0-spaces-alpha-20261124235736`. That alpha depends on the stable
  `lex-data` and `lex-cbor` `0.1.11`, so `lex-json` moved to stable `0.1.10` (what `lex-rpc` pins)
  and the root `overrides` came out: the alpha packages now pin each other exactly.

**Left alone, deliberately.** `migrations/0002_spaces.sql` still describes the old form in a
comment; an applied migration's checksum is verified, so it is never edited. Idempotency-key
replays of responses cached before the deploy can still carry old-form URIs until they expire.

**Not affected.** The 11-24 alpha's other changes: Antiphony makes no space call on an app
password (it reads on a delegation and a space credential), runs no PDS, imports no archives,
declares no space type with collections (`anySpace` lists none), and doesn't use `lex-space`'s
typed record helpers or `records()`.

**Deploy order (tenants).** A tenant that validates Antiphony's responses with
`@antiphony/shared` `0.15.x` refuses an `at:space/` URI in `SpaceView.uri`, `RemoteSpaceUriSchema`
or a StrongRef. Tenants move to `0.16.0` first; then core-api deploys and migration 0012 runs.

## Names: October 29 alpha → November 12 alpha

Earlier specs were written against the October 29 alpha (or before). Read these names in their
place. Sources: the [November 12 migration prompt](https://github.com/bluesky-social/atproto/blob/permissioned-data/alpha-migrations/prompt-11-12-26.md),
[proposals#143](https://github.com/bluesky-social/proposals/pull/143), and the published packages.

| Older name | Now | Notes |
| :--- | :--- | :--- |
| `com.atproto.simplespace.*` (one policy with `readPolicy` / `writePolicy`) | Three policies: `com.atproto.personalspace.policy`, `com.atproto.memberspace.policy` (`publicRead`, `publicWrite`, `allowedApps`, `publishPolicy`, `publishMembers`), `com.atproto.managedspace.policy` (`managingApp`, a `did#serviceId`) | October 29. A space has one policy. Create/update/delete moved to `com.atproto.space.*`. |
| `simplespace.checkUserAccess` (`user`, `access: read\|write`) | `com.atproto.managedspace.checkAccess?space=&repo=&clientId=` → `{ read, write }` | `repo` is optional: with none, answer for public reads only. Service auth `lxm` is the new NSID. A failing app is `UpstreamFailure`, not a denial. |
| `putMember` / `removeMember` | `com.atproto.memberspace.putMembers` / `removeMembers` | Batches of up to 100. |
| `com.atproto.space.getSpaceCredential` (`credentialKid`) | `com.atproto.space.authorizeSpaceSync` (`credentialKey`, optional `notify`) → `{ credential, spaceRev? }` | Registering for notifications is part of the same call now. |
| `registerNotify`, `notifyWrite`, `notifySpaceDeleted` | `notify` on `authorizeSpaceSync`; space host → syncer `notifySpaceUpdate` (`repoWrite`, `repoRemoved`, `spaceDeleted`, `registrationExpired`); repo host → space host `notifyRepoUpdate` | Syncers serve `confirmRegistration`. A registration lives only as long as its latest credential. |
| `notifyCredentialRevoked` | `notifyCredentialsRevoked` | |
| `listRepos` | `listWriters` (entries are `#repoWrite` or `#repoRemoved`) | |
| `Atproto-Space-Want-Mac` / `Atproto-Space-Mac` | `Accept-Signature` (tag `atproto-space-record` or `atproto-space-commit`), answered by `Atproto-Space-Record` / `Atproto-Space-Commit` and an RFC 9421 `hmac-sha256` signature | The secret is HPKE Secret Export (RFC 9180 §6.2) now. Old and new don't interoperate. |
| `BadSpaceMac`, `UserNotAuthorized`, `NotSpaceOwner` | `InvalidSpaceMac`, `AccountNotAuthorized`, `NotAuthorized` | |
| `AtUri.makeSpace(...)` | `new SpaceRef(did, type, skey).recordUri(author, collection, rkey)` | `@atproto/syntax`. |
| `createSpaceToken`, `createSpaceSigHeaders(key, opts)` | `createDelegationToken`, `createSpaceCredential`, `createSpaceSigHeaders({ …, keypair })` → `{ headers }` | `@atproto/space`. |
| Space type declaration `name`; scope parameter `type` | `title`; `spaceType` (`space?spaceType=…&authority=*`) | The positional scope form `space:<type>?…` is unchanged. |

Unchanged: `#atproto_kem`, `com.atproto.space.getDelegationToken`, `getRecord`, `getBlob`, and token
lifetimes (delegation 60 s and single use; credential 600 s). The URI shape changed on 11-24 (above).

**Antiphony's own policy names.** The tenant spaces API (`/api/v1/spaces`, Phase 2 of
[`spaces.md`](./spaces.md)) still takes `readPolicy` / `writePolicy` of `public`, `member-list`
or `managing-app`. They are Antiphony's own and never go on the wire to another host, so they
don't break. But they no longer match the protocol. If Phase 3 or tenant demand brings them
back, adopt the protocol's three policies then. Don't keep a translation layer.

## The plan

| # | When | Step | Who | State |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Now | Pin `@atproto/space`, `syntax` and `crypto` to `0.0.0-spaces-alpha-20261113224550`. Port Phase C's reader to `authorizeSpaceSync` and the new MAC. Check it against the reference PDS. | antiphony | **Done 2026-11-14** (CHANGELOG, Unreleased). Conformance: `space-repo.conformance.test.ts`, 6 of 6. |
| 2 | Now | Update the specs and docs to these names, so tenants don't build to old ones. | antiphony | **Done 2026-11-14** |
| 3 | Week of 11-16, now Dec 1 | **URI decision.** Watch the thread and the beta docs and SDK. If `at:space/`, switch every place listed above in one contract minor, before any kept recording. | antiphony | **Done 2026-11-25.** `at:space/` chosen in the 11-24 alpha; switched in contract `0.11.0` (above). Bardcast may keep recordings once it deploys. |
| 4 | Each Thursday alpha (11-19, 11-26 if any) | Bump the pin, run the unit suite and the conformance test, and read that week's migration prompt. | antiphony | **11-17 alpha done 2026-11-21:** pinned to `0.0.0-spaces-alpha-20261117141222`; no migration prompt published for it; unit suite and conformance (6 of 6) pass with no code changes. **11-24 alpha done 2026-11-25:** pinned to `0.0.0-spaces-alpha-20261124235736`, with its [migration prompt](https://github.com/bluesky-social/atproto/blob/permissioned-data/alpha-migrations/prompt-11-24-26.md) applied (the URI switch, step 3). Unit suites pass; conformance not rerun here. |
| 5 | Before Dec 1 | **Tenants:** Bardcast and Vox Pop build `com.atproto.managedspace.checkAccess` (not `checkUserAccess`) where they manage spaces. They rename `name` → `title` in space type declarations and `type` → `spaceType` in named OAuth scopes. They create spaces with one of the three policies. | bardcast, vox-pop | |
| 6 | Dec 1 | **Beta.** Move the pins to the beta release (watch whether it ships as stable versions; if so, drop the Dependabot ignores and the root `overrides`). Rerun conformance. Deploy core-api. | antiphony | |
| 7 | Dec 1 + days | **Live check.** Phase C against real accounts on Bluesky's PDS and a group on `opensocial.fyi`: a delegation from a test account, a record read with a verified MAC, a blob. This needs test accounts Brad creates. | antiphony, Brad | |
| 8 | After Dec 1 | **People's PDSes hold spaces.** Members' records can move to their own PDSes (step 7 of [`audio-service-and-groups.md`](./audio-service-and-groups.md)). Antiphony's temporary repo hosting and custody pinning can then retire (step 8). | bardcast, antiphony | |
| 9 | Now | Move the Phase C reader onto `@atproto/lex-space` (findings below). | antiphony | **Done 2026-11-14** (Brad asked for it ahead of the URI decision): unit suite and conformance, 6 of 6. |

## Upstream packages worth using (surveyed 2026-11-14)

All 62 `@atproto` and 40 `@atproto-labs` packages on npm were checked. Most `@atproto-labs`
entries are `0.0.1` placeholders from 2026-08-14. Every candidate below bundles for Workers
(esbuild, browser platform) with no Node built-ins.

| Package | Replaces | Verdict |
| :--- | :--- | :--- |
| **`@atproto/lex-space`** (`SpaceReader`) | Most of `space-repo.ts`: the credential exchange, request signing, MAC requests and verification, writer routing | **Adopted 2026-11-14.** `space-repo.ts` keeps `SpaceRepoPort`, its classification, and the network policy, in a `fetch` every library request goes through: HTTPS only, no redirects, a timeout per method, and a byte cap on blobs (the library buffers a blob whole with no cap of its own). The tenant's single-use token is handed to `delegationTokenProvider` once; the library's retry after a writer rejects the credential then reads `unreachable`. Records come back as lex values (CID objects for `$link`), so they're returned as JSON through `lexToJson`. The library also checks a record's CID against its MAC and a blob's bytes against its CID. Costs: the gzipped upload went from 416 to 529 KiB, and bundled module evaluation rose by about 15–20 ms. |
| `@atproto/did` + `@atproto-labs/did-resolver` | DID document parsing for space reads | **Adopted with `lex-space`**: the space adapter resolves DIDs through `createDidResolver` (`allowHttp: false`, under the same `fetch`), and `kemDidKeyOf` is gone from `did-document.ts`. `DidError` codes are classified as before: a directory 404/410 or no `#atproto_pds` is `gone`, a failed fetch `unreachable`, a document without `#atproto_kem` `invalid`. `public-repo.ts` keeps `did-document.ts`, and `app-did.ts` keeps its own resolution: its HTTPS-only rules and gone-vs-unreachable classification drive custody and the sweep, and it retires with custody pinning (step 8 of `audio-service-and-groups.md`). |
| `@atproto/lex-server` | The Hono XRPC adapter, and `signed-service-auth.ts`'s JWT verification (`serviceAuth`) | A candidate for the XRPC-first 1.0 ([`xrpc-surface.md`](./xrpc-surface.md) D-11): Web-standard `Request`/`Response`, so it runs on Workers. Not before then; it needs generated lexicon schemas, and Zod stays the runtime contract until 1.0 ([`xrpc-and-atproto-lex-strategy.md`](./xrpc-and-atproto-lex-strategy.md)). |
| `@atproto/oauth-scopes` | Hand-built `space:` scope strings in the tenants | For Bardcast and Vox Pop, not Antiphony: it parses and checks scopes, `spaceType` included. |
| `@atproto/lex-cbor` (`cidForLex`) | `lib/cid.ts` over `@ipld/dag-cbor` | Skip. 63 lines, and a swap risks changing CIDs already sealed into StrongRefs; only with a byte-identical test across stored records. |
| `@atproto/tap` | A future firehose subscription for public remote posts (Phase D, `audio-service-mode.md` §8.1) | Later. It's a client for Tap, a Go service someone would have to host. |
| Not useful here | | `@atproto/xrpc-server` (Express), `@atproto/api` (Bluesky's client), the OAuth clients (the tenants hold sessions), the reference services (`pds`, `bsky`, `ozone`), `@atproto-labs/fetch-node` (Node-only SSRF protection; Workers' `fetch` can't reach private networks anyway), and the deprecated `identifier`, `nsid`, `uri` and `lex-password-agent`. |

Not needed for the beta, and not built: notification registration (`notify`,
`confirmRegistration`, `notifySpaceUpdate`). Antiphony reads once per registration or recheck
and keeps no synchronized copy. If remote rechecks (`audio-service-mode.md` §8.1) ever want
push, this is where to start.

## Risks

- **One more breaking release.** The protocol team expects only the URI change, but can't
  promise it. Step 4 catches anything else.
- **The fleet rolls out over days.** Until a writer's PDS is upgraded, its DID document may have
  no `#atproto_kem`, and Phase C answers `invalid` ("no P-256 #atproto_kem key"). Tenants can
  fall back to Phase B (pushing the bytes) for those writers.
- **`opensocial.fyi` may lag the beta.** Group spaces depend on it, so step 7 is what tells us.
- **Package hygiene.** Alpha snapshots have twice published stray `0.0.0` or `0.0.0-stage`
  versions that a caret range picks up. Keep every `@atproto/*` pin exact.
