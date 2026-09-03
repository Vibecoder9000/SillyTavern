import { describe, expect, test } from '@jest/globals';
import { CHARACTER_CARD_MASK_SENTINEL, maskCharacterCardText, rebaseCharacterCardMaskRanges, redactCharacterCardValues, restoreCharacterCardMasks } from '../public/scripts/character-card-mask.js';

describe('character card model masking', () => {
    test('replaces each opaque span with the distinct sentinel', () => {
        const source = 'cheerful, curious, private detail, and impatient';
        const start = source.indexOf('private detail');
        expect(maskCharacterCardText(source, [{ start, end: start + 'private detail'.length }])).toBe(`cheerful, curious, ${CHARACTER_CARD_MASK_SENTINEL}, and impatient`);
    });

    test('restores hidden source text while accepting edits around it', () => {
        const source = 'alpha SECRET omega';
        const restored = restoreCharacterCardMasks(`new alpha ${CHARACTER_CARD_MASK_SENTINEL} revised omega`, source, [{ start: 6, end: 12 }]);
        expect(restored).toEqual({ text: 'new alpha SECRET revised omega', ranges: [{ start: 10, end: 16 }] });
    });

    test('accepts generated replacements while rejecting duplicated sentinels', () => {
        const source = 'alpha SECRET omega';
        expect(restoreCharacterCardMasks('alpha guessed omega', source, [{ start: 6, end: 12 }])).toEqual({ text: 'alpha guessed omega', ranges: [], replaced: true });
        expect(restoreCharacterCardMasks(`${CHARACTER_CARD_MASK_SENTINEL} ${CHARACTER_CARD_MASK_SENTINEL}`, source, [{ start: 6, end: 12 }])).toMatchObject({ code: 'masked-content-changed' });
    });

    test('manual edits retain non-overlapping masks and clear intersected masks', () => {
        expect(rebaseCharacterCardMaskRanges('AA secret ZZ', 'prefix AA secret ZZ', [{ start: 3, end: 9 }])).toEqual([{ start: 10, end: 16 }]);
        expect(rebaseCharacterCardMaskRanges('AA secret ZZ', 'AA replacement ZZ', [{ start: 3, end: 9 }])).toEqual([]);
    });

    test('final payload redaction removes copies outside the card snapshot', () => {
        expect(redactCharacterCardValues('context: SECRET; repeat SECRET', ['SECRET'])).toBe(`context: ${CHARACTER_CARD_MASK_SENTINEL}; repeat ${CHARACTER_CARD_MASK_SENTINEL}`);
        expect(redactCharacterCardValues(CHARACTER_CARD_MASK_SENTINEL, ['MASK'])).toBe(CHARACTER_CARD_MASK_SENTINEL);
    });
});
