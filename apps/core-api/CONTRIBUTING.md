# Contributing to Vox Pop

Thanks for your interest in contributing! Vox Pop follows an open-core model — the base voice messaging platform is open source, while premium features (AI, voice isolation, etc.) are proprietary. See [FEATURES.md](FEATURES.md) for the full breakdown.

## Getting Started

### Prerequisites

- Node.js 22 (see `.nvmrc`)
- npm
- A Firebase project (or use emulators for local dev)

### Setup

Before starting, ensure you have Node 22 (or use the pinned Volta/NVM settings) and Java on your PATH.

```bash
git clone https://github.com/bbthorson/vox-pop.git
cd vox-pop
npm install

# Check prerequisites (Node, Java, Firebase CLI, free ports)
npm run doctor

# Boot the full development stack (emulators + core-api + Next.js web + seed data)
npm run dev:stack
```

Then open `http://localhost:3000` and sign in locally using the dev tester credentials:

```bash
curl -X POST http://localhost:3000/api/auth/dev-login
```


### Project Structure

```
apps/web/          — Next.js web application
apps/mobile/       — Expo React Native app
apps/core-api/     — Hono open-core API service
functions/         — Firebase Cloud Functions
packages/core/     — Open-core service interfaces + classes
packages/shared/   — Shared types, Zod schemas, errors
specs/             — Internal architecture / design intent
docs/              — External / operational reference (this file lives here)
```

## Development Workflow

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Run `npm run build` to verify the build passes
4. Run `npx vitest run` for tests
5. Open a pull request

## Open-Core Tier Boundaries

Code marked with `@proprietary` in JSDoc comments depends on paid third-party services (Google Gemini, ElevenLabs, Firebase Cloud Messaging) and is part of the hosted platform, not the open-source core.

**When contributing:**
- **Tier 1 (Open Core)** code should not import from Tier 2 services. Core recording, replies, users, and organizations should work without AI or paid service dependencies.
- **Tier 2 (Proprietary)** features run in Cloud Functions or behind feature-gated API routes. They degrade gracefully when API keys are missing.

If you're unsure which tier your change falls into, just ask in the PR.

## Code Style

- TypeScript strict mode everywhere
- Zod schemas for all request/response validation
- Use the existing `ServiceError` hierarchy for errors (`NotFoundError`, `ForbiddenError`, etc.)
- Auth goes through `protectedRoute()` — never manually construct Bearer headers in components
- Keep it simple. Functional > Perfect.

## Reporting Issues

- Use GitHub Issues for bugs and feature requests
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
