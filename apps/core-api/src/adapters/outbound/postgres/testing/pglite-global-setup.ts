import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { bootMigratedPglite } from './pglite-boot.js';

/**
 * Vitest `globalSetup`: boot and migrate ONE PGlite instance per run, dump its
 * data directory, and hand the dump's path to every test file.
 *
 * Why: `PGlite.create()` runs initdb inside WASM, which costs ~3–4s per call
 * (the migrations themselves take ~0.1s). Seven files each paying that in a
 * `beforeAll` put the suite's slowest hooks within reach of the 10s hook
 * timeout on a busy machine — reproducibly, with four CPU-bound processes
 * running alongside. Loading a dump costs ~0.7s, and each file still gets its
 * own isolated database, because each load is a fresh instance.
 */
export default async function setup(project: TestProject): Promise<() => void> {
    const dir = mkdtempSync(join(tmpdir(), 'antiphony-pglite-'));
    const path = join(dir, 'template.tar');
    const pg = await bootMigratedPglite();
    const dump = await pg.dumpDataDir('none');
    writeFileSync(path, Buffer.from(await dump.arrayBuffer()));
    await pg.close();
    project.provide('pgliteTemplatePath', path);
    return () => rmSync(dir, { recursive: true, force: true });
}
