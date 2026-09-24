#!/usr/bin/env node
/**
 * check-design-tokens.mjs
 *
 * Verifies that CSS and Astro styles in apps/docs strictly adhere to Antiphony's
 * design system tokens (var(--ap-*) or var(--sl-*)), with no hardcoded raw hex
 * or rgb/hsl colors leaking into components or stylesheets.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const docsSrc = join(root, 'apps', 'docs', 'src');

const HEX_COLOR_REGEX = /#([0-9a-fA-F]{3,8})\b/g;
const RGB_COLOR_REGEX = /\b(rgb|rgba|hsl|hsla)\(\s*[0-9]/g;

// Files allowed to define the root palette anchors
const EXEMPT_FILES = new Set([
  join(root, 'packages', 'tokens', 'tokens.css'),
]);

function isExemptHex(line, matchIndex, matchText) {
  // Check if this is an HTML entity like &#123; or &#x1f;
  if (matchIndex > 0 && line[matchIndex - 1] === '&') {
    return true;
  }
  // Check if line contains URL fragment or SVG clipPath/mask reference or atproto
  if (line.includes(`href="#`) || line.includes(`url(#`) || line.includes(`id="`)) {
    return true;
  }
  // Check if line is within comments
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return true;
  }
  return false;
}

function scanDir(dir, fileList = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, fileList);
    } else if (entry.endsWith('.css') || entry.endsWith('.astro')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const files = scanDir(docsSrc);
let violations = 0;

for (const file of files) {
  if (EXEMPT_FILES.has(file)) continue;

  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const isAstro = file.endsWith('.astro');
  let inStyleBlock = !isAstro; // In CSS files, always in style

  lines.forEach((line, index) => {
    if (isAstro) {
      if (line.includes('<style')) inStyleBlock = true;
      if (line.includes('</style>')) {
        inStyleBlock = false;
        return;
      }
      // If not in a <style> block, only check if there is an inline style="..."
      if (!inStyleBlock && !line.includes('style=')) {
        return;
      }
    }

    // Only check lines that look like CSS declarations (property: value)
    if (!line.includes(':') && !line.includes('=')) {
      return;
    }

    // Check for hardcoded hex colors
    let match;
    HEX_COLOR_REGEX.lastIndex = 0;
    while ((match = HEX_COLOR_REGEX.exec(line)) !== null) {
      if (!isExemptHex(line, match.index, match[0])) {
        console.error(
          `[design-tokens] ${relative(root, file)}:${index + 1}: hardcoded color '${match[0]}' found. Use var(--ap-*) instead.\n  > ${line.trim()}`
        );
        violations++;
      }
    }

    // Check for hardcoded rgb/hsl colors (unless inside color-mix using tokens)
    RGB_COLOR_REGEX.lastIndex = 0;
    while ((match = RGB_COLOR_REGEX.exec(line)) !== null) {
      if (!line.includes('var(--ap-') && !line.includes('var(--sl-') && !isExemptHex(line, match.index, match[0])) {
        console.error(
          `[design-tokens] ${relative(root, file)}:${index + 1}: hardcoded color '${match[0]}' found. Use var(--ap-*) instead.\n  > ${line.trim()}`
        );
        violations++;
      }
    }
  });
}

if (violations > 0) {
  console.error(`\n[design-tokens] Failed: Found ${violations} design token violation(s).`);
  process.exit(1);
} else {
  console.log(`[design-tokens] Passed: All checked files strictly adhere to design system tokens.`);
}
