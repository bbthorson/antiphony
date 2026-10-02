# @antiphony/tokens

Antiphony design system tokens structured around the **Two Voices** call-and-response duotone philosophy (Indigo call, Coral response, Slate neutrals).

This is a private monorepo package consumed by `@antiphony/docs` and other internal workspaces. It provides typed JavaScript/TypeScript constants, CSS custom properties (`--ap-*`), and accessibility contrast validation utilities.

## What lives here

- **`tokens.css`**: Core CSS custom properties (`--ap-color-*`, `--ap-surface-*`, `--ap-font-*`, `--ap-space-*`, `--ap-waveform-*`).
- **`index.ts`**: TypeScript constants (`CALL_PALETTE`, `RESPONSE_PALETTE`, `NEUTRAL_PALETTE`, `TOKENS`) and WCAG 2.1 AA/AAA contrast utilities (`calculateContrastRatio`, `passesWcagAa`).
- **`tokens.test.ts`**: Vitest suite asserting WCAG 2.1 compliance and token completeness.

## Usage

### In CSS / Astro:

```css
@import '@antiphony/tokens/tokens.css';

.call-element {
  color: var(--ap-color-call);
  background-color: var(--ap-surface-raised);
}

.response-element {
  color: var(--ap-color-response);
}
```

### In TypeScript / JavaScript:

```ts
import { TOKENS, CALL_PALETTE, RESPONSE_PALETTE } from '@antiphony/tokens';
```

## Testing & Enforcement

Enforced repo-wide by `npm run test:design-tokens` (asserts that CSS and Astro sources strictly use `--ap-*` design tokens rather than raw color codes) and custom lint rule `eslint-rules/no-hardcoded-design-tokens.mjs`.

```bash
npm test -w @antiphony/tokens
```
