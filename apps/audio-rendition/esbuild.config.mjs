import { build } from 'esbuild';

/**
 * esbuild production bundle.
 *
 * Bundled for the same reason core-api's Node build was: a single
 * extension-correct `dist/index.js` means the runtime does no module resolution
 * and the container needs no `node_modules`. This service has three runtime
 * dependencies and all of them bundle cleanly — there is no `external` list,
 * which is itself worth noticing after core-api's history with `firebase-admin`
 * and `ffmpeg-static`.
 *
 * Note `ffmpeg` is NOT a bundled dependency and cannot be: it is a binary the
 * image installs, spawned off PATH. The Dockerfile asserts it at build time and
 * `src/index.ts` probes at startup, because nothing in this file can.
 */
await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/index.js',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
});

console.log('[esbuild] dist/index.js built');
