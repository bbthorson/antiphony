import { describe, it, expect } from 'vitest';
import {
    sentimentKey,
    computeAggregateDelta,
    promptAggregateUpdate,
    type AggregateDeltaAccumulator,
} from './replies-dependencies';

/**
 * Pure-function tests for the aggregate-delta helpers shared by both the
 * apps/core-api and apps/web Firebase bindings. The Firebase-coupled
 * `updateReplyStatusWithAggregates` path is exercised by the bindings'
 * integration suites; this file pins the rule logic itself.
 */

// A capturing increment factory so tests can read back the (delta, key) pairs
// the helper hands to Firestore's FieldValue.increment.
function tagged(delta: number) {
    return { __increment: delta };
}

describe('sentimentKey', () => {
    it('maps the three valid enum values to lowercase buckets', () => {
        expect(sentimentKey('Positive')).toBe('positive');
        expect(sentimentKey('Neutral')).toBe('neutral');
        expect(sentimentKey('Negative')).toBe('negative');
    });

    it('returns null for missing / unknown sentiment so callers can opt out cleanly', () => {
        expect(sentimentKey(undefined)).toBeNull();
        expect(sentimentKey(null)).toBeNull();
        expect(sentimentKey('')).toBeNull();
        expect(sentimentKey('positive')).toBeNull(); // case-sensitive — guards against case drift
        expect(sentimentKey('Unknown')).toBeNull();
    });
});

describe('computeAggregateDelta', () => {
    it('returns null when the flip does not cross the live boundary', () => {
        // archived → deleted: neither contributes to aggregates
        expect(
            computeAggregateDelta('archived', 'deleted', 'complete', 'Positive', 7, tagged),
        ).toBeNull();
        // live → live: no-op
        expect(
            computeAggregateDelta('live', 'live', 'complete', 'Positive', 7, tagged),
        ).toBeNull();
    });

    it('returns null when the reply lacks AI enrichment', () => {
        expect(
            computeAggregateDelta('live', 'archived', 'pending', 'Positive', 7, tagged),
        ).toBeNull();
        expect(
            computeAggregateDelta('live', 'archived', 'error', 'Positive', 7, tagged),
        ).toBeNull();
        expect(
            computeAggregateDelta('live', 'archived', undefined, 'Positive', 7, tagged),
        ).toBeNull();
    });

    it('returns null when sentiment or engagementScore is missing on a complete reply', () => {
        expect(
            computeAggregateDelta('live', 'archived', 'complete', undefined, 7, tagged),
        ).toBeNull();
        expect(
            computeAggregateDelta('live', 'archived', 'complete', 'Positive', undefined, tagged),
        ).toBeNull();
    });

    it('emits a negative delta on live → archived for a complete reply', () => {
        const delta = computeAggregateDelta('live', 'archived', 'complete', 'Positive', 8, tagged);
        expect(delta).toEqual({
            engagementScoreSum: { __increment: -8 },
            engagementScoreCount: { __increment: -1 },
            'sentimentCounts.positive': { __increment: -1 },
        });
    });

    it('emits a positive delta on archived → live for a complete reply', () => {
        const delta = computeAggregateDelta('archived', 'live', 'complete', 'Negative', 3, tagged);
        expect(delta).toEqual({
            engagementScoreSum: { __increment: 3 },
            engagementScoreCount: { __increment: 1 },
            'sentimentCounts.negative': { __increment: 1 },
        });
    });

    it('emits a negative delta on live → deleted', () => {
        const delta = computeAggregateDelta('live', 'deleted', 'complete', 'Neutral', 5, tagged);
        expect(delta).toEqual({
            engagementScoreSum: { __increment: -5 },
            engagementScoreCount: { __increment: -1 },
            'sentimentCounts.neutral': { __increment: -1 },
        });
    });

    it('emits a positive delta on deleted → live', () => {
        const delta = computeAggregateDelta('deleted', 'live', 'complete', 'Positive', 9, tagged);
        expect(delta).toEqual({
            engagementScoreSum: { __increment: 9 },
            engagementScoreCount: { __increment: 1 },
            'sentimentCounts.positive': { __increment: 1 },
        });
    });
});

describe('promptAggregateUpdate', () => {
    it('skips sentiment buckets with zero delta to keep writes minimal', () => {
        const acc: AggregateDeltaAccumulator = {
            sumDelta: 7,
            countDelta: 1,
            positive: 1,
            neutral: 0,
            negative: 0,
        };
        const update = promptAggregateUpdate(acc, tagged);
        expect(update).toEqual({
            engagementScoreSum: { __increment: 7 },
            engagementScoreCount: { __increment: 1 },
            'sentimentCounts.positive': { __increment: 1 },
        });
        // No zero-delta keys leak in:
        expect(update).not.toHaveProperty('sentimentCounts.neutral');
        expect(update).not.toHaveProperty('sentimentCounts.negative');
    });

    it('emits all three buckets when each is non-zero, with mixed signs', () => {
        const acc: AggregateDeltaAccumulator = {
            sumDelta: -3,
            countDelta: -1,
            positive: -1,
            neutral: 2,
            negative: -1,
        };
        const update = promptAggregateUpdate(acc, tagged);
        expect(update).toEqual({
            engagementScoreSum: { __increment: -3 },
            engagementScoreCount: { __increment: -1 },
            'sentimentCounts.positive': { __increment: -1 },
            'sentimentCounts.neutral': { __increment: 2 },
            'sentimentCounts.negative': { __increment: -1 },
        });
    });

    it('always emits sum and count even when zero (so the prompt doc field exists)', () => {
        // No-op delta is still a valid edge: bulk caller may pass it through.
        const acc: AggregateDeltaAccumulator = {
            sumDelta: 0,
            countDelta: 0,
            positive: 0,
            neutral: 0,
            negative: 0,
        };
        const update = promptAggregateUpdate(acc, tagged);
        expect(update).toEqual({
            engagementScoreSum: { __increment: 0 },
            engagementScoreCount: { __increment: 0 },
        });
    });
});
