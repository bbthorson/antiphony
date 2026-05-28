/**
 * Generates `apps/core-api/openapi.json` from the live route declarations.
 *
 * Bundles itself via esbuild before executing — same pattern as the main
 * `npm run build` (see `esbuild.config.mjs`). Bundling is required because
 * the source imports cross-workspace via tsconfig path aliases
 * (`shared/*`, `@vox-pop/core/*`); Node's ESM resolver doesn't honor those.
 *
 * Run via `npm run gen:openapi -w @vox-pop/core-api` (also invoked from
 * `npm run build` so the artifact stays fresh in CI). The output is
 * committed so the public docs site can read it at build time without
 * standing up core-api.
 *
 * Only routes registered via `app.openapi(createRoute(...), handler)`
 * appear in the document. As of the toolchain pilot the `/users/*`
 * family is instrumented; subsequent PRs will add the remaining
 * namespaces per `specs/drafts/openapi-generation.md`.
 */
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outputPath = resolve(projectRoot, 'openapi.json');

// 1. Bundle a runner module that imports the app + emits the spec. Both
//    the entry and the output live INSIDE apps/core-api so Node resolves
//    externals (pino, firebase-admin, etc.) via the project's
//    node_modules. Project-internal temp file; cleaned up on exit.
const runnerEntry = resolve(projectRoot, 'src/__gen-openapi-runner.ts');
const runnerOutDir = resolve(projectRoot, '.openapi-runner');
const runnerOut = resolve(runnerOutDir, 'runner.mjs');
mkdirSync(runnerOutDir, { recursive: true });

writeFileSync(
    runnerEntry,
    `
import { app } from './app.js';

const a = app();
const document = a.getOpenAPIDocument({
    openapi: '3.0.0',
    info: {
        title: 'Vox Pop Core API',
        version: '0.1.0',
        description: 'Open-source REST surface for Vox Pop — actors, prompts, replies, audio.',
    },
});

process.stdout.write(JSON.stringify(document));
`,
);

try {
    await build({
        entryPoints: [runnerEntry],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        outfile: runnerOut,
        external: ['firebase-admin', 'pino', 'pino-pretty', 'rss-parser'],
        tsconfig: resolve(projectRoot, 'tsconfig.json'),
        absWorkingDir: projectRoot,
        logLevel: 'silent',
        banner: {
            js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
        },
    });
} finally {
    rmSync(runnerEntry, { force: true });
}

// 2. Spawn the runner; capture stdout as the spec JSON.
const { spawnSync } = await import('node:child_process');
const result = spawnSync(process.execPath, [runnerOut], { encoding: 'utf8' });

rmSync(runnerOutDir, { recursive: true, force: true });

if (result.status !== 0) {
    // `result.error` is populated when spawnSync itself failed to launch
    // (e.g., missing executable, system error). `result.stderr` has the
    // runner's output if it ran but exited non-zero. Surface both so
    // failures aren't blank.
    console.error(
        result.stderr || result.error?.message || '[gen:openapi] runner failed with no stderr',
    );
    process.exit(result.status ?? 1);
}

const document = JSON.parse(result.stdout);
writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n', 'utf8');

const pathCount = Object.keys(document.paths ?? {}).length;
console.log(`Wrote ${outputPath} (${pathCount} paths)`);
