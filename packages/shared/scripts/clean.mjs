// Prebuild: wipe the whole dist/ so the dual-tree output (dist/esm, dist/cjs)
// never inherits stale files from a prior build (e.g. the old single-tree
// tsc output). Cross-platform — no `rm -rf`.
//
// Resolve dist/ relative to THIS script rather than the CWD: this is a
// destructive recursive delete, so it must target the package's own dist
// regardless of where the build happens to be invoked from.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

rmSync(distPath, { recursive: true, force: true });
