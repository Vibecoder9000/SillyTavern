import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    getWorkspaceCachedValue,
    invalidateWorkspaceCachedValue,
    runOncePerWorkspace,
    setWorkspaceCachedValue,
    WORKSPACE_CACHE_KEYS,
} from '../public/scripts/chat-workspace-cache.js';

const originalWindow = globalThis.window;

function useWorkspaceWindow(parent = { location: { origin: 'http://localhost' } }) {
    globalThis.window = {
        location: { origin: 'http://localhost', search: '?workspaceRuntime=test' },
        parent,
    };
    return parent;
}

afterEach(() => {
    globalThis.window = originalWindow;
    jest.restoreAllMocks();
});

describe('chat workspace cache', () => {
    test('shares boot settings without a serialized activation snapshot protocol', async () => {
        useWorkspaceWindow();
        const loader = jest.fn(async () => ({ settings: 'server-value' }));

        await expect(getWorkspaceCachedValue(WORKSPACE_CACHE_KEYS.SETTINGS, loader))
            .resolves.toEqual({ settings: 'server-value' });
        await expect(getWorkspaceCachedValue(WORKSPACE_CACHE_KEYS.SETTINGS, loader))
            .resolves.toEqual({ settings: 'server-value' });
        expect(loader).toHaveBeenCalledTimes(1);
    });

    test('deduplicates loads and returns isolated clones', async () => {
        useWorkspaceWindow();
        const loader = jest.fn(async () => ({ nested: { value: 1 } }));

        const [first, second] = await Promise.all([
            getWorkspaceCachedValue('shared', loader),
            getWorkspaceCachedValue('shared', loader),
        ]);
        first.nested.value = 2;
        const third = await getWorkspaceCachedValue('shared', loader);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(second).toEqual({ nested: { value: 1 } });
        expect(third).toEqual({ nested: { value: 1 } });
    });

    test('supports replacement and invalidation', async () => {
        useWorkspaceWindow();
        const loader = jest.fn(async () => ({ version: 1 }));

        await getWorkspaceCachedValue('replaceable', loader);
        setWorkspaceCachedValue('replaceable', { version: 2 });
        expect(await getWorkspaceCachedValue('replaceable', loader)).toEqual({ version: 2 });

        invalidateWorkspaceCachedValue('replaceable');
        expect(await getWorkspaceCachedValue('replaceable', loader)).toEqual({ version: 1 });
        expect(loader).toHaveBeenCalledTimes(2);
    });

    test('reuses ready data from another frame with the same workspace parent', async () => {
        const parent = useWorkspaceWindow();
        const loader = jest.fn(async () => ({ shared: true }));
        await getWorkspaceCachedValue('cross-frame', loader);

        useWorkspaceWindow(parent);
        await expect(getWorkspaceCachedValue('cross-frame', loader)).resolves.toEqual({ shared: true });
        expect(loader).toHaveBeenCalledTimes(1);
    });

    test('evicts failed loads so a later call can retry', async () => {
        useWorkspaceWindow();
        const loader = jest.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce({ ready: true });

        await expect(getWorkspaceCachedValue('retry', loader)).rejects.toThrow('temporary failure');
        await expect(getWorkspaceCachedValue('retry', loader)).resolves.toEqual({ ready: true });
        expect(loader).toHaveBeenCalledTimes(2);
    });

    test('runs workspace tasks once and retries failures', async () => {
        useWorkspaceWindow();
        const task = jest.fn(async () => ({ completed: true }));

        const [first, second] = await Promise.all([
            runOncePerWorkspace('once', task),
            runOncePerWorkspace('once', task),
        ]);
        expect(first).toEqual({ completed: true });
        expect(second).toEqual({ completed: true });
        expect(task).toHaveBeenCalledTimes(1);

        const retryTask = jest.fn()
            .mockRejectedValueOnce(new Error('retry task'))
            .mockResolvedValueOnce('done');
        await expect(runOncePerWorkspace('retry-once', retryTask)).rejects.toThrow('retry task');
        await expect(runOncePerWorkspace('retry-once', retryTask)).resolves.toBe('done');
        expect(retryTask).toHaveBeenCalledTimes(2);
    });

    test('does not retain shared values outside a workspace child', async () => {
        globalThis.window = { location: { search: '' } };
        globalThis.window.parent = globalThis.window;
        const loader = jest.fn(async () => 'standalone');

        await getWorkspaceCachedValue('standalone', loader);
        await getWorkspaceCachedValue('standalone', loader);
        await runOncePerWorkspace('standalone-once', loader);
        await runOncePerWorkspace('standalone-once', loader);

        expect(loader).toHaveBeenCalledTimes(4);
    });
});
