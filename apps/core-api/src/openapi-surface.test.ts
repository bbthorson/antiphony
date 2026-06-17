import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { app } from './app.js';
import { extractSurface } from './lib/openapi-surface.js';

/**
 * Plan A (A5) — public-surface contract guard.
 *
 * Rebuilds the public API surface (path + method set) from the live routes and
 * fails if it has drifted from the committed `openapi.surface.json` snapshot.
 * Adding, removing, or renaming a public endpoint therefore fails CI until the
 * snapshot is regenerated (`npm run gen:openapi`) and committed in the SAME PR —
 * surface changes become deliberate, reviewed acts.
 *
 * This guards the surface *shape* only, not field-level contract detail within
 * an endpoint (that's Plan D). See `specs/plan-a-core-api-contract.md`.
 */
describe('public API surface (A5 contract guard)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const snapshotPath = resolve(here, '..', 'openapi.surface.json');

    async function liveSurface(): Promise<string[]> {
        const res = await app().fetch(new Request('http://localhost/openapi.json'));
        if (!res.ok) {
            throw new Error(`Failed to fetch /openapi.json: ${res.status} ${res.statusText}`);
        }
        const doc = await res.json();
        return extractSurface(doc);
    }

    it('matches the committed openapi.surface.json snapshot', async () => {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { endpoints: string[] };
        const live = await liveSurface();

        const snapshotSet = new Set(snapshot.endpoints);
        const liveSet = new Set(live);

        const added = live.filter((e) => !snapshotSet.has(e));
        const removed = snapshot.endpoints.filter((e) => !liveSet.has(e));

        // Surface a precise, actionable diff before the equality assertion so a
        // failure tells you exactly which endpoints drifted and how to fix it.
        if (added.length || removed.length) {
            const lines = [
                'Public API surface drifted from openapi.surface.json.',
                ...added.map((e) => `  + added (not in snapshot):   ${e}`),
                ...removed.map((e) => `  - removed (still in snapshot): ${e}`),
                'Run `npm run gen:openapi -w @vox-pop/core-api` and commit the updated snapshot in this PR.',
            ];
            throw new Error(lines.join('\n'));
        }

        expect(live).toEqual(snapshot.endpoints);
    });

    it('snapshot is sorted and de-duplicated (canonical form)', () => {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { endpoints: string[] };
        const canonical = [...new Set(snapshot.endpoints)].sort();
        expect(snapshot.endpoints).toEqual(canonical);
    });
});
