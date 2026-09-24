import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALL_PALETTE,
  RESPONSE_PALETTE,
  NEUTRAL_PALETTE,
  TOKENS,
  getContrastRatio,
  satisfiesWcagAA,
  satisfiesWcagLargeOrUI,
} from './index.js';

describe('Design System Tokens (@antiphony/tokens)', () => {
  it('defines all required tonal stops across brand palettes', () => {
    const requiredStops = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

    for (const stop of requiredStops) {
      expect(CALL_PALETTE[stop]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(RESPONSE_PALETTE[stop]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(NEUTRAL_PALETTE[stop]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  describe('WCAG 2.1 Accessibility & Contrast Compliance', () => {
    it('primary text on base surface passes WCAG AA (>= 4.5:1) in light mode', () => {
      const ratio = getContrastRatio(TOKENS.text.primaryLight, TOKENS.surface.baseLight);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(satisfiesWcagAA(TOKENS.text.primaryLight, TOKENS.surface.baseLight)).toBe(true);
    });

    it('primary text on base surface passes WCAG AA (>= 4.5:1) in dark mode', () => {
      const ratio = getContrastRatio(TOKENS.text.primaryDark, TOKENS.surface.baseDark);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(satisfiesWcagAA(TOKENS.text.primaryDark, TOKENS.surface.baseDark)).toBe(true);
    });

    it('selection ink on coral response background satisfies WCAG AA (>= 4.5:1)', () => {
      // Dark slate ink on coral response (WCAG AA requirement for selection highlight)
      const ratio = getContrastRatio(NEUTRAL_PALETTE[900], RESPONSE_PALETTE[500]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('dark mode call accent satisfies UI / interactive ratio (>= 3:1) on dark base', () => {
      const ratio = getContrastRatio(TOKENS.call.dark, TOKENS.surface.baseDark);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
      expect(satisfiesWcagLargeOrUI(TOKENS.call.dark, TOKENS.surface.baseDark)).toBe(true);
    });
  });

  describe('tokens.css completeness', () => {
    it('contains all core token declarations in CSS', () => {
      const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

      const expectedVars = [
        '--ap-call',
        '--ap-response',
        '--ap-surface-base',
        '--ap-surface-card',
        '--ap-surface-elevated',
        '--ap-border-subtle',
        '--ap-border-default',
        '--ap-text-primary',
        '--ap-text-secondary',
        '--ap-text-muted',
        '--ap-audio-waveform-played',
        '--ap-audio-waveform-unplayed',
        '--ap-font-display',
        '--ap-font-sans',
        '--ap-font-mono',
        '--ap-space-4',
        '--ap-radius-md',
        '--ap-shadow-md',
      ];

      for (const v of expectedVars) {
        expect(css).toContain(v);
      }
    });
  });
});
