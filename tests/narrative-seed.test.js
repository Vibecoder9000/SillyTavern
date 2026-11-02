import { describe, test, expect } from '@jest/globals';
import {
    buildNarrativeSeed,
    combineNarrativeSeed,
    computeChunkBoundaries,
    formatNarrativeSeedPrompt,
    getDefaultSelection,
    getSeedChunk,
    isValidNarrativeSeed,
} from '../public/scripts/narrative-seed-core.js';

describe('computeChunkBoundaries', () => {
    test('cuts on word starts and covers the whole text', () => {
        const text = 'one two three four five six';
        expect(computeChunkBoundaries(text, 3)).toEqual([0, 8, 19, text.length]);
    });

    test('keeps every character when sections are joined back together', () => {
        const text = '  odd   spacing\nand  lines here ';
        const seed = buildNarrativeSeed([text], 3);
        const rebuilt = [0, 1, 2].map(slot => getSeedChunk(seed, 0, slot)).join('');
        expect(rebuilt).toBe(text);
    });

    test('a draft with fewer words than chunks has empty sections', () => {
        const seed = buildNarrativeSeed(['only'], 3);
        expect([0, 1, 2].map(slot => getSeedChunk(seed, 0, slot))).toEqual(['', '', 'only']);
    });
});

describe('getDefaultSelection', () => {
    test('assigns draft k to slot k', () => {
        expect(getDefaultSelection(3, 3)).toEqual([0, 1, 2]);
    });

    test('rotates through the drafts that exist', () => {
        expect(getDefaultSelection(2, 3)).toEqual([0, 1, 0]);
        expect(getDefaultSelection(3, 5)).toEqual([0, 1, 2, 0, 1]);
    });
});

describe('buildNarrativeSeed', () => {
    test('returns null when no draft arrived', () => {
        expect(buildNarrativeSeed(['', '   '], 3)).toBeNull();
    });

    test('uses partial results and records how many failed', () => {
        const seed = buildNarrativeSeed(['a b c', '', 'd e f'], 3);
        expect(seed.drafts).toEqual(['a b c', 'd e f']);
        expect(seed.failed).toBe(1);
        expect(seed.selection).toEqual([0, 1, 0]);
        expect(isValidNarrativeSeed(seed)).toBe(true);
    });

    test('clamps an invalid chunk count', () => {
        expect(buildNarrativeSeed(['a b'], 0).selection).toEqual([0]);
        expect(buildNarrativeSeed(['a b'], 99).selection).toHaveLength(10);
    });
});

describe('combineNarrativeSeed', () => {
    const seed = buildNarrativeSeed(['a1 a2 a3', 'b1 b2 b3', 'c1 c2 c3'], 3);

    test('defaults to draft k for slot k, one chunk per line', () => {
        expect(combineNarrativeSeed(seed)).toBe('a1\nb2\nc3');
    });

    test('honours a custom selection without changing the stored one', () => {
        expect(combineNarrativeSeed(seed, [2, 2, 0])).toBe('c1\nc2\na3');
        expect(seed.selection).toEqual([0, 1, 2]);
    });

    test('skips empty sections', () => {
        const short = buildNarrativeSeed(['x', 'y y y'], 3);
        expect(combineNarrativeSeed(short, [0, 1, 0])).toBe('y\nx');
    });
});

describe('isValidNarrativeSeed', () => {
    test('rejects malformed stored data', () => {
        expect(isValidNarrativeSeed(null)).toBe(false);
        expect(isValidNarrativeSeed({ drafts: [] })).toBe(false);
        expect(isValidNarrativeSeed({ drafts: ['a'], boundaries: [], selection: [0] })).toBe(false);
    });
});

describe('formatNarrativeSeedPrompt', () => {
    test('replaces the placeholder literally', () => {
        expect(formatNarrativeSeedPrompt('Use: {{seed}}', 'costs $& more')).toBe('Use: costs $& more');
    });

    test('appends the seed when the template has no placeholder', () => {
        expect(formatNarrativeSeedPrompt('Rules', 'seed')).toBe('Rules\n\nseed');
    });
});
