import { describe, expect, test } from '@jest/globals';
import { formatLorebookContentField, parseLorebookContentField, resolveDeleteCardSpan, resolveInsertCardText, resolveReplaceCardText, setPendingCardValue, xmlCdata } from '../public/scripts/character-card-edit.js';

describe('character card surgical edit helpers', () => {
    test('the same exact edit helpers support localized lorebook content changes', () => {
        const source = 'Visible intro\n<img src="/user/images/masked.png">\nSecret ending';
        const replacement = resolveReplaceCardText(source, { find: 'masked.png', replace: 'revealed.png' });
        expect(source.slice(0, replacement.start) + replacement.replacement + source.slice(replacement.end)).toContain('revealed.png');

        const deletion = resolveDeleteCardSpan(source, { from: '<img', until: 'Secret ending' });
        expect(source.slice(0, deletion.start) + source.slice(deletion.end)).toBe('Visible intro\nSecret ending');

        const insertion = resolveInsertCardText(source, { content: 'Gate: ', position: 'before', anchor: 'Secret ending' });
        expect(source.slice(0, insertion.start) + insertion.replacement + source.slice(insertion.end)).toContain('Gate: Secret ending');
    });

    test('an insertion can populate a not-yet-existing numbered greeting or example field', () => {
        const insertion = resolveInsertCardText('', { content: 'A new opening', position: 'end' });
        expect(insertion).toMatchObject({ start: 0, end: 0, replacement: 'A new opening', operation: 'insert' });
    });

    test('manual pending edits remain actionable until they exactly restore the base value', () => {
        const textPending = { before: 'original', after: 'proposal' };
        expect(setPendingCardValue(textPending, 'manual revision')).toBe(true);
        expect(textPending.after).toBe('manual revision');
        expect(setPendingCardValue(textPending, 'original')).toBe(false);

        const collectionPending = { before: ['first', 'second'], after: ['first', 'proposed second'] };
        expect(setPendingCardValue(collectionPending, ['first'])).toBe(true);
        expect(collectionPending.after).toEqual(['first']);
        expect(setPendingCardValue(collectionPending, ['first', 'second'])).toBe(false);
    });

    test('lorebook content is addressed through the same field argument as card text', () => {
        const field = formatLorebookContentField('entry-123');
        expect(field).toBe('Character Book Entry [entry-123] Content');
        expect(parseLorebookContentField(field)).toEqual({ entryId: 'entry-123', label: field });
        expect(parseLorebookContentField('Character Book')).toBeNull();
    });

    test('CDATA preserves raw HTML and safely splits a CDATA terminator', () => {
        const value = '<img src="/face.png"> ]]> tail';
        const wrapped = xmlCdata(value);
        expect(wrapped).toContain('<img src="/face.png">');
        expect(wrapped).toBe('<![CDATA[<img src="/face.png"> ]]]]><![CDATA[> tail]]>');
    });
});
