---
title: Design System & Tokens
description: The "Two Voices" duotone system, color tokens, typography scales, accessibility guarantees, and automated enforcement.
---

Antiphony uses a design system structured around the **"Two Voices"** call-and-response duotone philosophy. It is packaged as `@antiphony/tokens` and strictly enforced across the codebase.

## The Two Voices Philosophy

In antiphonal music and open social audio, a conversation consists of two distinct voices:

1. **The Call (`--ap-call` / Indigo)**: The prompt, the inquiry, structural authority, links, and primary interactive surfaces.
2. **The Response (`--ap-response` / Coral)**: The reply, active audio playback, focus accents, selection moments, and dialogue indicators.

By restricting strong color accents to these two distinct voices, Antiphony interfaces feel like active, focused conversations rather than cluttered dashboards.

## Token Reference

### Voice 1: Indigo (The Call)

| Token | Light Value | Dark Value | Purpose |
| :--- | :--- | :--- | :--- |
| `--ap-call` | `#4f46e5` (600) | `#6366f1` (500) | Primary call actions, buttons, links |
| `--ap-call-subtle` | `#e0e7ff` (100) | `rgba(99, 102, 241, 0.15)` | Badges, hovered surfaces, call cards |
| `--ap-call-hover` | `#4338ca` (700) | `#818cf8` (400) | Button hover states |
| `--ap-call-glow` | `rgba(79, 70, 229, 0.2)` | `rgba(99, 102, 241, 0.35)` | Elevation shadows, active focus rings |

### Voice 2: Coral (The Response)

| Token | Light Value | Dark Value | Purpose |
| :--- | :--- | :--- | :--- |
| `--ap-response` | `#f97362` (500) | `#f97362` (500) | Reply threads, active audio waveform progress |
| `--ap-response-subtle`| `#ffe4e1` (100) | `rgba(249, 115, 98, 0.18)`| Reply cards, response badges |
| `--ap-response-hover` | `#e85645` (600) | `#fc737c` (400) | Response button hover |
| `--ap-response-glow`  | `rgba(249, 115, 98, 0.25)`| `rgba(249, 115, 98, 0.35)`| Response focus rings, active player pulses |

### Surfaces & Neutral Ramps

Neutral tones follow a clean Slate ramp (`--ap-neutral-50` to `--ap-neutral-950`).

| Token | Light Theme | Dark Theme | Purpose |
| :--- | :--- | :--- | :--- |
| `--ap-surface-base` | `#ffffff` | `#080c15` (950) | Primary background |
| `--ap-surface-elevated`| `#f8fafc` (50) | `#0f1523` | Top nav, cards, sidebars |
| `--ap-surface-card` | `#ffffff` | `rgba(15, 21, 35, 0.8)` | Foreground cards, dialogs |
| `--ap-surface-sunken` | `#f1f5f9` (100) | `#05080e` | Code blocks, transcript insets |
| `--ap-border-subtle` | `rgba(203, 213, 225, 0.6)`| `rgba(255, 255, 255, 0.08)` | Dividers, card boundaries |
| `--ap-border-default`| `#cbd5e1` (300) | `rgba(255, 255, 255, 0.14)` | Form inputs, buttons |

### Audio Waveform States

| Token | Value | Purpose |
| :--- | :--- | :--- |
| `--ap-audio-waveform-played` | `var(--ap-call)` | Played waveform peaks for call prompts |
| `--ap-audio-waveform-response-played` | `var(--ap-response)` | Played waveform peaks for replies |
| `--ap-audio-waveform-unplayed` | `var(--ap-neutral-300)` / `700` | Unplayed peak backdrop |
| `--ap-audio-pulse` | `var(--ap-response)` | Recording indicator pulse |

## Accessibility & Contrast Guarantees

All color pairings are mathematically verified in automated CI tests (`packages/tokens/tokens.test.ts`):

- **Normal Text Contrast**: ≥ 4.5:1 against surfaces (WCAG 2.1 AA).
- **UI Elements & Large Text**: ≥ 3.0:1 against surfaces.
- **Selection Highlight**: Dark slate ink (`#0f172a`) on Coral (`#f97362`), ensuring 5.9:1 contrast (surpassing standard white-on-coral which is sub-AA at 2.7:1).

## Strict Enforcement

Design tokens are strictly enforced via two automated gates:

1. **Custom ESLint Rule (`antiphony/no-hardcoded-design-tokens`)**:
   Runs during `npm run lint`. Forbids raw hex codes (`#...`), `rgb(...)`, or `hsl(...)` in style objects, JSX style props, or CSS properties.
2. **Automated Token Verifier (`scripts/check-design-tokens.mjs`)**:
   Runs during `npm test`. Recursively scans all `.css` and `.astro` files to ensure zero arbitrary hardcoded colors leak into production.
