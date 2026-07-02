import { build } from 'esbuild';

/**
 * esbuild production bundle for core-api.
 *
 * Why bundle: core-api's source imports from `@antiphony/core/*` and `shared/*`
 * via tsconfig path aliases. At runtime, Node's ESM resolver doesn't honor
 * tsconfig paths, and the workspace symlink indirection + ESM-from-CJS
 * named-import interop makes pure-Node resolution of these aliases
 * unreliable. Bundling at build time inlines all workspace source so the
 * runtime sees a single, extension-correct `dist/index.js`.
 *
 * Externals:
 *   - Node built-ins — auto-external with `platform: 'node'`.
 *   - `firebase-admin` — has native transitive deps (protobufjs, grpc-js
 *     variants) that esbuild can't safely flatten. App Hosting runs
 *     `npm install` in the container, so `node_modules/firebase-admin` is
 *     present at runtime; keeping it external avoids bundling ~50MB.
 *   - `pino` — imports platform-specific worker scripts via `require()`
 *     which don't bundle cleanly.
 *
 * Everything else (Hono, @hono/node-server, zod, @antiphony/core,
 * @antiphony/shared) bundles. Bundled output is ~500KB-1MB; cold start is
 * fast (single-file load, no module-resolution overhead).
 *
 * Source maps are on so stack traces in Cloud Logging point at the
 * original TS files.
 */

await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/index.js',
    external: ['firebase-admin', 'pino', 'pino-pretty'],
    // esbuild needs the tsconfig to honor the path aliases (shared/*, @antiphony/core/*).
    tsconfig: 'tsconfig.json',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
    // Bake the git SHA and build timestamp into the bundle so /health can
    // report them without a runtime env var. COMMIT_SHA is injected by
    // Firebase App Hosting's Cloud Build environment; BUILD_TIME is stamped
    // here at bundle time (close enough to deploy time for drift detection).
    define: {
        'process.env.COMMIT_SHA': JSON.stringify(process.env.COMMIT_SHA ?? 'dev'),
        'process.env.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    },
    // ESM bundles need to hint to Node that __filename/__dirname don't exist.
    // Not using them ourselves, but some bundled deps might — banner injects
    // the createRequire shim so dynamic `require()` calls from bundled CJS
    // libs work.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
});

console.log('[esbuild] dist/index.js built');
