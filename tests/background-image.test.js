import { describe, expect, test } from '@jest/globals';
import { areBackgroundImagesEqual, getEffectiveBackgroundImage, normalizeBackgroundImage } from '../public/scripts/util/background-image.js';

const baseUrl = 'https://example.test/app/';

describe('normalizeBackgroundImage', () => {
    test('resolves relative URLs and ignores decoder reset fragments', () => {
        expect(normalizeBackgroundImage('url("backgrounds/forest.webp#st-bg-decoder-reset-3")', baseUrl))
            .toBe('https://example.test/app/backgrounds/forest.webp');
    });

    test('normalizes no-background values to null', () => {
        expect(normalizeBackgroundImage('none', baseUrl)).toBeNull();
        expect(normalizeBackgroundImage('url("backgrounds/__transparent.png")', baseUrl)).toBeNull();
    });
});

describe('areBackgroundImagesEqual', () => {
    test('matches equivalent relative and absolute URLs', () => {
        expect(areBackgroundImagesEqual(
            'url("backgrounds/forest.webp")',
            'url("https://example.test/app/backgrounds/forest.webp")',
            baseUrl,
        )).toBe(true);
    });

    test('matches an in-progress transition target', () => {
        const effectiveBackground = getEffectiveBackgroundImage(
            'url("backgrounds/old.webp")',
            ['url("backgrounds/older.webp")', 'url("backgrounds/forest.webp")'],
        );
        expect(areBackgroundImagesEqual(effectiveBackground, 'url("backgrounds/forest.webp")', baseUrl)).toBe(true);
    });

    test('matches transparent and none backgrounds', () => {
        expect(areBackgroundImagesEqual('none', 'url("backgrounds/__transparent.png")', baseUrl)).toBe(true);
    });

    test('does not match different backgrounds', () => {
        expect(areBackgroundImagesEqual(
            'url("backgrounds/forest.webp")',
            'url("backgrounds/mountain.webp")',
            baseUrl,
        )).toBe(false);
    });
});
