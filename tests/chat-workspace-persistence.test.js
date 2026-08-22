import { describe, expect, jest, test } from '@jest/globals';
import { createCoalescedWriter, createKeyedCoalescedWriter } from '../public/scripts/chat-workspace-persistence.js';

describe('chat workspace persistence coalescing', () => {
    test('continuous updates persist only the latest trailing snapshot', async () => {
        jest.useFakeTimers();
        const writes = [];
        const writer = createCoalescedWriter(async value => writes.push(value), { delay: 200 });

        for (let index = 0; index < 100; index++) writer.schedule({ draft: `text-${index}`, scrollTop: index });
        expect(writes).toEqual([]);
        await jest.advanceTimersByTimeAsync(199);
        expect(writes).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        expect(writes).toEqual([{ draft: 'text-99', scrollTop: 99 }]);
        jest.useRealTimers();
    });

    test('keeps one in-flight write and one replacement snapshot', async () => {
        jest.useFakeTimers();
        let releaseFirst;
        const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
        const writes = [];
        const writer = createCoalescedWriter(async value => {
            writes.push(value);
            if (writes.length === 1) await firstBlocked;
        }, { delay: 10 });

        writer.schedule('first');
        await jest.advanceTimersByTimeAsync(10);
        writer.schedule('obsolete');
        writer.schedule('latest');
        await jest.advanceTimersByTimeAsync(10);
        expect(writes).toEqual(['first']);
        releaseFirst();
        await Promise.resolve();
        await Promise.resolve();
        expect(writes).toEqual(['first', 'latest']);
        jest.useRealTimers();
    });

    test('coalesces keyed writes independently and serializes each key', async () => {
        let releaseFirst;
        const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
        const writes = [];
        const writer = createKeyedCoalescedWriter(async (key, value) => {
            writes.push([key, value]);
            if (key === 'character-a' && value === 'first') await firstBlocked;
        }, { delay: 0 });

        const first = writer.flush('character-a', 'first');
        const replacement = writer.flush('character-a', 'latest');
        await writer.flush('character-b', 'only');

        expect(writes).toEqual([
            ['character-a', 'first'],
            ['character-b', 'only'],
        ]);
        releaseFirst();
        await Promise.all([first, replacement]);
        expect(writes).toEqual([
            ['character-a', 'first'],
            ['character-b', 'only'],
            ['character-a', 'latest'],
        ]);
    });
});
