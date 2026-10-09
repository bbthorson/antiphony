# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

**<https://github.com/bbthorson/antiphony/security/advisories/new>**

Include what you can of:

- the affected component (`apps/core-api`, `apps/audio-rendition`,
  `@antiphony/shared`, `@antiphony/capture-kit`, the lexicons, …) and version or
  commit;
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- whether it affects the hosted service at `api.antiphony.dev`, a self-hosted
  deployment, or both.

Please do not test against other tenants' data on `api.antiphony.dev`, and do
not run load or denial-of-service tests against it.

## What to expect

Antiphony is maintained by a single maintainer, so timelines are best-effort:

- an acknowledgement, usually within a week;
- an initial assessment once the report has been reproduced;
- a fix, or a mitigation plan, communicated through the advisory before any
  public disclosure.

We will credit you in the published advisory unless you ask us not to.

## Supported versions

Antiphony is pre-1.0. Only the latest release line receives security fixes:

| Component | Supported |
| :--- | :--- |
| `@antiphony/shared` — latest `0.x` release | Yes |
| `@antiphony/capture-kit` — latest `0.x` release | Yes |
| The API contract — latest `0.x` revision, as deployed at `api.antiphony.dev` | Yes |
| Older `0.x` releases | No — upgrade to the latest |

Self-hosters should track `master`; fixes land there first.
