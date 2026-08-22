import { describe, expect, test } from '@jest/globals';
import { getAnimatedWebpDuration } from '../public/scripts/util/animated-webp.js';

function fourCc(value) {
    return [...value].map(character => character.charCodeAt(0));
}

function chunk(type, payload) {
    const bytes = [...fourCc(type), payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 24) & 0xff, ...payload];
    if (payload.length % 2) bytes.push(0);
    return bytes;
}

function animatedWebp(frameDurations) {
    const chunks = frameDurations.map(duration => {
        const payload = new Array(16).fill(0);
        payload[12] = duration & 0xff;
        payload[13] = (duration >> 8) & 0xff;
        payload[14] = (duration >> 16) & 0xff;
        return chunk('ANMF', payload);
    }).flat();
    const riffSize = 4 + chunks.length;
    return new Uint8Array([
        ...fourCc('RIFF'),
        riffSize & 0xff,
        (riffSize >> 8) & 0xff,
        (riffSize >> 16) & 0xff,
        (riffSize >> 24) & 0xff,
        ...fourCc('WEBP'),
        ...chunks,
    ]).buffer;
}

describe('getAnimatedWebpDuration', () => {
    test('sums ANMF frame durations', () => {
        expect(getAnimatedWebpDuration(animatedWebp([100, 250, 650]))).toBe(1000);
    });

    test('handles odd-sized chunks and RIFF padding', () => {
        const bytes = new Uint8Array(animatedWebp([100]));
        const oddChunk = chunk('JUNK', [1]);
        const existingChunks = [...bytes.subarray(12)];
        const riffSize = 4 + oddChunk.length + existingChunks.length;
        const result = new Uint8Array([
            ...fourCc('RIFF'),
            riffSize & 0xff,
            (riffSize >> 8) & 0xff,
            (riffSize >> 16) & 0xff,
            (riffSize >> 24) & 0xff,
            ...fourCc('WEBP'),
            ...oddChunk,
            ...existingChunks,
        ]);
        expect(getAnimatedWebpDuration(result)).toBe(100);
    });

    test('rejects non-WebP data', () => {
        expect(getAnimatedWebpDuration(new Uint8Array(32))).toBeNull();
    });

    test('returns null when there are no animation frames', () => {
        const payload = [1, 2, 3, 4];
        const data = new Uint8Array([
            ...fourCc('RIFF'), 12, 0, 0, 0, ...fourCc('WEBP'), ...chunk('VP8 ', payload),
        ]);
        expect(getAnimatedWebpDuration(data)).toBeNull();
    });
});
