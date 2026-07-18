import { describe, it, expect } from 'vitest';
import { planMigration } from './processed-blob-cid-migration.js';

describe('planMigration', () => {
    it('moves the legacy value when no current value exists', () => {
        expect(planMigration('bafyLegacy', undefined)).toEqual({
            kind: 'migrate',
            cid: 'bafyLegacy',
        });
    });

    it('is idempotent when both fields already hold the same value', () => {
        // The state left by a pass that wrote the new key but died before
        // deleting the old one. Must converge, not be treated as a conflict.
        expect(planMigration('bafySame', 'bafySame')).toEqual({
            kind: 'migrate',
            cid: 'bafySame',
        });
    });

    it('keeps the newer value and drops the legacy one on a real conflict', () => {
        expect(planMigration('bafyOld', 'bafyNew')).toEqual({
            kind: 'drop-legacy',
            kept: 'bafyNew',
            dropped: 'bafyOld',
        });
    });

    it('never overwrites a current value with the legacy one', () => {
        // The whole risk of this migration: clobbering a freshly processed
        // variant with a stale denoise-era CID would silently revert audio.
        const action = planMigration('bafyOld', 'bafyNew');
        expect(action.kind).toBe('drop-legacy');
        if (action.kind === 'drop-legacy') {
            expect(action.kept).toBe('bafyNew');
        }
    });

    it.each([
        ['empty string', ''],
        ['whitespace only', '   '],
        ['null', null],
        ['a number', 42],
        ['a map', { nested: true }],
    ])('skips an unusable legacy value: %s', (_label, value) => {
        const action = planMigration(value, undefined);
        expect(action.kind).toBe('skip');
    });

    it('skips rather than migrating when the legacy value is junk but a current value exists', () => {
        const action = planMigration('', 'bafyNew');
        expect(action.kind).toBe('skip');
    });

    it('reports the offending value in the skip reason', () => {
        const action = planMigration('', undefined);
        if (action.kind !== 'skip') throw new Error('expected a skip');
        expect(action.reason).toContain('""');
    });
});
