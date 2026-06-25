// Postbuild: stamp dist/ as CommonJS.
//
// The package root is `"type": "module"` so that tsx (core-api dev) and other
// bundlers load this package's *source* .ts files as ESM — that keeps a single
// zod module instance across the ESM/CJS boundary, without which
// `@hono/zod-openapi`'s `.openapi()` extension never reaches schemas defined
// here (see the dual-package-hazard fix). But the *build* still emits CommonJS
// (tsconfig.build → module: commonjs) because `functions` consumes the built
// `@antiphony/shared` via `require()`. This marker tells Node to interpret the
// emitted dist/*.js as CommonJS regardless of the package root's `type`.
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
