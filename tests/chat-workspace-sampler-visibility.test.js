import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { isTextGenControlVisible } from '../public/scripts/textgen-control-visibility.js';

const textgenSettingsScript = readFileSync(new URL('../public/scripts/textgen-settings.js', import.meta.url), 'utf8');

describe('text-generation control visibility', () => {
    test('applies API type and sampler selection as independent constraints', () => {
        const state = { apiType: 'vllm', prioritizeManual: true, activeSamplers: ['temperature', 'top_p'] };

        expect(isTextGenControlVisible({}, state)).toBe(true);
        expect(isTextGenControlVisible({ type: 'vllm' }, state)).toBe(true);
        expect(isTextGenControlVisible({ type: 'ooba' }, state)).toBe(false);
        expect(isTextGenControlVisible({ type: 'all' }, state)).toBe(true);
        expect(isTextGenControlVisible({ type: 'ooba', typeMode: 'except' }, state)).toBe(true);
        expect(isTextGenControlVisible({ type: 'vllm', typeMode: 'except' }, state)).toBe(false);
        expect(isTextGenControlVisible({ samplers: 'top_k, temperature' }, state)).toBe(true);
        expect(isTextGenControlVisible({ samplers: 'top_k, min_p' }, state)).toBe(false);
        expect(isTextGenControlVisible({ type: 'ooba', samplers: 'temperature' }, state)).toBe(false);
    });

    test('applies manual selection only when the renderer enables that constraint', () => {
        expect(isTextGenControlVisible(
            { samplers: 'top_k' },
            { apiType: 'vllm', prioritizeManual: false, activeSamplers: [] },
        )).toBe(true);
        expect(isTextGenControlVisible(
            { samplers: 'top_k' },
            { apiType: 'vllm', prioritizeManual: true, activeSamplers: [] },
        )).toBe(false);
    });

    test('renderer is write-only and does not use jQuery visibility reads', () => {
        const start = textgenSettingsScript.indexOf('function showSamplerControls');
        const end = textgenSettingsScript.indexOf('\n}', start) + 2;
        const renderer = textgenSettingsScript.slice(start, end);

        expect(renderer).toContain("classList.toggle('textgen-control-hidden'");
        expect(renderer).not.toContain('.show(');
        expect(renderer).not.toContain('.hide(');
        expect(renderer).not.toContain('getComputedStyle');
        expect(renderer).not.toContain(':visible');
    });
});
