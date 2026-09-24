/**
 * Antiphony Design System — Token Constants & Utilities
 *
 * Provides typed access to Two Voices design tokens and WCAG contrast ratio validators.
 */

export const CALL_PALETTE = {
  50: '#eef2ff',
  100: '#e0e7ff',
  200: '#c7d2fe',
  300: '#a5b4fc',
  400: '#818cf8',
  500: '#6366f1',
  600: '#4f46e5',
  700: '#4338ca',
  800: '#3730a3',
  900: '#312e81',
  950: '#1e1b4b',
} as const;

export const RESPONSE_PALETTE = {
  50: '#fff1f0',
  100: '#ffe4e1',
  200: '#ffccd3',
  300: '#ffa2a8',
  400: '#fc737c',
  500: '#f97362',
  600: '#e85645',
  700: '#c33e2f',
  800: '#a23326',
  900: '#852f26',
  950: '#49150f',
} as const;

export const NEUTRAL_PALETTE = {
  50: '#f8fafc',
  100: '#f1f5f9',
  200: '#e2e8f0',
  300: '#cbd5e1',
  400: '#94a3b8',
  500: '#64748b',
  600: '#475569',
  700: '#334155',
  800: '#1e293b',
  900: '#0f172a',
  950: '#080c15',
} as const;

export const TOKENS = {
  call: {
    light: CALL_PALETTE[600],
    dark: CALL_PALETTE[500],
  },
  response: {
    light: RESPONSE_PALETTE[500],
    dark: RESPONSE_PALETTE[500],
  },
  surface: {
    baseLight: '#ffffff',
    baseDark: NEUTRAL_PALETTE[950],
    elevatedLight: NEUTRAL_PALETTE[50],
    elevatedDark: '#0f1523',
  },
  text: {
    primaryLight: NEUTRAL_PALETTE[900],
    primaryDark: NEUTRAL_PALETTE[50],
    secondaryLight: NEUTRAL_PALETTE[600],
    secondaryDark: NEUTRAL_PALETTE[300],
    mutedLight: NEUTRAL_PALETTE[500],
    mutedDark: NEUTRAL_PALETTE[400],
  },
  typography: {
    display: "'Sora Variable', ui-sans-serif, system-ui, sans-serif",
    sans: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
    mono: "'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', monospace",
  },
} as const;

/**
 * Calculates relative luminance for a given hex color code according to WCAG 2.1.
 */
export function getRelativeLuminance(hex: string): number {
  const cleanHex = hex.replace(/^#/, '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  const rLin = toLinear(r);
  const gLin = toLinear(g);
  const bLin = toLinear(b);

  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Computes the contrast ratio between two hex colors according to WCAG 2.1.
 * Return value is in the range [1, 21].
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(hex1);
  const lum2 = getRelativeLuminance(hex2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

/**
 * Validates whether a foreground and background pair satisfies WCAG 2.1 AA (4.5:1 for normal text).
 */
export function satisfiesWcagAA(foreground: string, background: string): boolean {
  return getContrastRatio(foreground, background) >= 4.5;
}

/**
 * Validates whether a foreground and background pair satisfies WCAG 2.1 AA for large text or UI elements (3:1).
 */
export function satisfiesWcagLargeOrUI(foreground: string, background: string): boolean {
  return getContrastRatio(foreground, background) >= 3.0;
}
