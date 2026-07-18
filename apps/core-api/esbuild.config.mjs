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
 *   - `ffmpeg-static` — CJS that resolves its bundled binary through
 *     `path.join(__dirname, ...)` at module scope. Inlined into this ESM
 *     bundle that identifier does not exist, so the process dies on startup
 *     before serving anything. It also points at a path inside
 *     `node_modules`, which only means anything if the package is really
 *     there — bundling it could never have worked.
 *
 * Everything else (Hono, @hono/node-server, zod, @antiphony/core,
 * @antiphony/shared) bundles. Bundled output is ~500KB-1MB; cold start is
 * fast (single-file load, no module-resolution overhead).
 *
 * Source maps are on so stack traces in Cloud Logging point at the
 * original TS files.
 */

const options = {
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/index.js',
    external: ['firebase-admin', 'pino', 'pino-pretty', 'ffmpeg-static'],
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
    // Banner shims `require` so dynamic `require()` from bundled CJS libs works.
    //
    // It deliberately does NOT shim `__dirname`/`__filename`. A dep that reads
    // those is locating a file relative to its own package, and in a bundle
    // there is no such directory — pointing them at `dist/` would resolve to
    // something that isn't there and turn a startup crash into a silent
    // misbehavior. Such deps belong in `external` instead; see `ffmpeg-static`.
    // The assertion below enforces that.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
};

await build(options);

// Fail the build if a CJS-only identifier survived into the ESM bundle.
//
// `ffmpeg-static` shipped a bundle that died on its first line of module
// evaluation, and nothing caught it: no test loads `dist/`, so the whole suite
// stayed green through two PRs and a review while the deployable artifact could
// not boot. This is the cheapest place to notice.
//
// The scan runs over a MINIFIED rebuild, not the shipped bundle. The shipped
// one keeps comments (`minify: false`, so stack traces stay readable), and a
// bundled dependency is free to mention `__dirname` in a comment or a string
// without ever referencing it — a text match there would fail the build over
// nothing. Minifying first drops comments and tree-shakes unused literals,
// while a real reference always survives: `__dirname` is undeclared in ESM, and
// esbuild cannot rename a global it never bound. So this trades away most false
// positives and no detection.
//
// Residual: a string literal that is genuinely reachable and spells the
// identifier exactly would still trip this. Left as-is deliberately — a false
// positive is a loud build failure someone reads in a minute, a false negative
// is an artifact that cannot boot, and this guard exists because the second one
// already shipped once.
const { outputFiles } = await build({
    ...options,
    outfile: undefined,
    outdir: undefined,
    write: false,
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'silent',
});
const bundled = outputFiles[0].text;
const leaked = ['__dirname', '__filename'].filter((id) =>
    new RegExp(`(^|[^\\w$.])${id}\\b`).test(bundled),
);
if (leaked.length > 0) {
    console.error(
        `[esbuild] ${leaked.join(', ')} leaked into the ESM bundle — it will throw ` +
            `ReferenceError on startup.\nThe dependency using it must be added to ` +
            `\`external\` in this file, not shimmed via the banner.`,
    );
    process.exit(1);
}

console.log('[esbuild] dist/index.js built');
