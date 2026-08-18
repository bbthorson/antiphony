import { describe, it, expect } from 'vitest';
import { dataPresence, isAudioBlackout, type R2ListLike } from './data-presence.js';
import type { SqlClient } from '../ports/sql-client.js';

/**
 * These cover an incident that already happened: for ~20 minutes
 * `api.antiphony.dev` served an empty Neon and an empty R2 while `/health`
 * returned `ok:true, backend:"postgres"` and post listings returned successful
 * empty pages. Nothing lied; nothing answered "is there anything here".
 *
 * The distinction the tests protect is between `empty` and `unavailable`.
 * Collapsing them is the tempting simplification and it destroys the value: an
 * empty store is a fact about the deployment, an unreadable one is a fact about
 * the probe, and treating a failed query as "nothing here" would announce a
 * blackout every time the database hiccupped.
 */
const sqlReturning = (rows: unknown[]): SqlClient => ({
    query: async () => rows as never,
});
const sqlThrowing = (): SqlClient => ({
    query: async () => {
        throw new Error('relation "posts" does not exist');
    },
});
const bucketWith = (count: number): R2ListLike => ({
    list: async () => ({ objects: Array.from({ length: count }, (_, i) => i) }),
});
const bucketThrowing = (): R2ListLike => ({
    list: async () => {
        throw new Error('R2 unreachable');
    },
});

describe('dataPresence', () => {
    it('reports present when both stores hold something', async () => {
        const p = await dataPresence({ sql: sqlReturning([{ present: true }]), bucket: bucketWith(1) });
        expect(p).toEqual({ records: 'present', blobs: 'present' });
    });

    it('reports empty for a store that answered and holds nothing', async () => {
        const p = await dataPresence({ sql: sqlReturning([{ present: false }]), bucket: bucketWith(0) });
        expect(p).toEqual({ records: 'empty', blobs: 'empty' });
    });

    it('reports unavailable rather than empty when the query throws', async () => {
        // The distinction that matters: a missing table is not an empty table.
        const p = await dataPresence({ sql: sqlThrowing(), bucket: bucketWith(1) });
        expect(p.records).toBe('unavailable');
    });

    it('reports unavailable rather than empty when R2 throws', async () => {
        const p = await dataPresence({ sql: sqlReturning([{ present: true }]), bucket: bucketThrowing() });
        expect(p.blobs).toBe('unavailable');
    });

    it('reports unavailable when a binding is absent entirely', async () => {
        expect(await dataPresence({})).toEqual({ records: 'unavailable', blobs: 'unavailable' });
    });

    it('never rejects, because /health must not fail on a diagnostic', async () => {
        await expect(dataPresence({ sql: sqlThrowing(), bucket: bucketThrowing() })).resolves.toEqual({
            records: 'unavailable',
            blobs: 'unavailable',
        });
    });
});

describe('isAudioBlackout', () => {
    it('is true for records present with no blobs — the incident', async () => {
        expect(isAudioBlackout({ records: 'present', blobs: 'empty' })).toBe(true);
    });

    it('is false for a new deployment where both are empty', () => {
        // Both empty needs a different response than the blackout, so calling it
        // one would train whoever reads the log to ignore the line.
        expect(isAudioBlackout({ records: 'empty', blobs: 'empty' })).toBe(false);
    });

    it('is false when the probe could not read a store', () => {
        expect(isAudioBlackout({ records: 'present', blobs: 'unavailable' })).toBe(false);
    });

    it('is false for a healthy deployment', () => {
        expect(isAudioBlackout({ records: 'present', blobs: 'present' })).toBe(false);
    });
});
