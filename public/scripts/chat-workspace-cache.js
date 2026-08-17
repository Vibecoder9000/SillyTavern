const WORKSPACE_CACHE_PROPERTY = '__sillyTavernWorkspaceCacheV1__';

export const WORKSPACE_CACHE_KEYS = Object.freeze({
    SETTINGS: 'settings',
    EXTENSIONS: 'extensions',
    EXTENSION_AUTO_UPDATE: 'extension-auto-update',
    EXTENSION_DAILY_CHECK: 'extension-daily-check',
});

function cloneValue(value) {
    return structuredClone(value);
}

function getWorkspaceCacheStore() {
    if (typeof window === 'undefined' || window.parent === window) return null;
    const query = new URLSearchParams(window.location.search);
    if (!query.has('workspaceRuntime')) return null;

    window.parent[WORKSPACE_CACHE_PROPERTY] ??= {
        values: new Map(),
        once: new Map(),
    };
    return window.parent[WORKSPACE_CACHE_PROPERTY];
}

/**
 * Gets a cloned value from the current workspace cache, loading it once when absent.
 * Standalone pages call the loader directly.
 * @template T
 * @param {string} key Cache key
 * @param {() => Promise<T> | T} loader Value loader
 * @returns {Promise<T>}
 */
export async function getWorkspaceCachedValue(key, loader) {
    const store = getWorkspaceCacheStore();
    if (!store) return loader();

    if (!store.values.has(key)) {
        const load = Promise.resolve().then(loader);
        store.values.set(key, load);
        load.catch(() => {
            if (store.values.get(key) === load) store.values.delete(key);
        });
    }
    return cloneValue(await store.values.get(key));
}

/**
 * Replaces a value in the current workspace cache.
 * @param {string} key Cache key
 * @param {any} value Serializable value
 */
export function setWorkspaceCachedValue(key, value) {
    const store = getWorkspaceCacheStore();
    if (!store) return;
    store.values.set(key, Promise.resolve(cloneValue(value)));
}

/**
 * Invalidates a value in the current workspace cache.
 * @param {string} key Cache key
 */
export function invalidateWorkspaceCachedValue(key) {
    getWorkspaceCacheStore()?.values.delete(key);
}

/**
 * Runs a task once for the lifetime of the current workspace page.
 * Failed tasks are removed so a later caller can retry them.
 * Standalone pages run the task normally.
 * @template T
 * @param {string} key Task key
 * @param {() => Promise<T> | T} task Task to run
 * @returns {Promise<T>}
 */
export async function runOncePerWorkspace(key, task) {
    const store = getWorkspaceCacheStore();
    if (!store) return task();

    if (!store.once.has(key)) {
        const run = Promise.resolve().then(task);
        store.once.set(key, run);
        run.catch(() => {
            if (store.once.get(key) === run) store.once.delete(key);
        });
    }
    return cloneValue(await store.once.get(key));
}
