import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

/**
 * Bundle the Worker and fail if a Node-only dependency got back into it.
 *
 * ## Why this needs to be a build gate rather than a review habit
 *
 * `app.ts` and every route handler are shared by the Node and Workers entry
 * points, so the Worker bundle's contents are decided by the whole transitive
 * import graph of the application — not by anything visible in `worker.ts`. One
 * ordinary-looking import in a middleware file is enough: `middleware/rate-
 * limit.ts` defaulted its store argument to the Firestore binding, and that
 * single default pulled `firebase-admin`, `google-auth-library`, `protobufjs`
 * and `grpc` into the bundle — 7MB of it, from a line that read like a
 * convenience.
 *
 * Nothing else catches this. `tsc` is happy, the tests are happy, and
 * `wrangler deploy` is happy too: it bundles all of it without complaint and
 * the Worker fails at runtime, in production, on whichever request first
 * reaches the code that needs a runtime it does not have.
 *
 * This is the same class of guard as the `__dirname` leak check in
 * `esbuild.config.mjs`, and it exists for the same reason: the failure it
 * prevents has already shipped once.
 *
 * ## Why a text scan rather than a dependency graph
 *
 * The question is not "is this package in `dependencies`" — it legitimately is,
 * for the Node build. It is "did its code end up in this artifact", and the
 * artifact is the only thing that can answer. Names are matched against the
 * bundle's own text, which esbuild leaves in module banner comments and in the
 * require shims, so a package that is genuinely absent scores zero.
 */

/**
 * Packages that must never reach the Worker bundle, with the reason — printed
 * on failure, because "firebase-admin is in the bundle" is not actionable on
 * its own and the fix is always "find the import, install it via native.ts".
 */
const FORBIDDEN = [
    ['firebase-admin', 'CommonJS with native transitive deps (grpc, protobufjs)'],
    ['google-auth-library', 'reaches the GCE metadata server for ADC; a Worker has none'],
    ['ffmpeg-static', 'resolves its binary via __dirname at module scope'],
    ['node:child_process', 'not provided by nodejs_compat'],
    ['pino', 'resolves transport scripts through require() at module scope'],
];

const outdir = mkdtempSync(join(tmpdir(), 'antiphony-worker-'));
try {
    execFileSync(
        'wrangler',
        ['deploy', '--dry-run', '--outdir', outdir],
        // `wrangler` from node_modules/.bin; inherit stderr so a genuine bundle
        // error is readable rather than swallowed into an exit code.
        { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CI: '1' } },
    );

    const bundle = readFileSync(join(outdir, 'worker.js'), 'utf8');
    const leaked = FORBIDDEN.filter(([name]) => bundle.includes(name));

    if (leaked.length > 0) {
        console.error(
            '[worker-bundle] Node-only dependencies reached the Worker bundle:\n' +
                leaked.map(([name, why]) => `  - ${name} — ${why}`).join('\n') +
                '\n\nFind the import chain that reaches it and move the concrete adapter ' +
                'behind an install seam in src/native.ts. See that file for the pattern.',
        );
        process.exit(1);
    }

    const kib = Math.round(Buffer.byteLength(bundle) / 1024);
    console.log(`[worker-bundle] clean — ${kib} KiB, no Node-only dependencies`);
} finally {
    rmSync(outdir, { recursive: true, force: true });
}
