const WORKSPACE_CACHE_PROPERTY = '__sillyTavernWorkspaceCacheV1__';
const MAX_CACHED_CHATS = 12;

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
        chats: new Map(),
    };
    const store = window.parent[WORKSPACE_CACHE_PROPERTY];
    store.chats ??= new Map();
    return store;
}

function getChatCacheKey(identity) {
    if (!identity?.kind || !identity?.ownerId || !identity?.chatId) return null;
    return `${identity.kind}:${identity.ownerId}:${identity.chatId}`;
}

/**
 * Returns a cloned snapshot of a chat previously loaded by this workspace.
 * Reading refreshes its LRU position so frequently switched tabs stay warm.
 * @param {{kind: string, ownerId: string, chatId: string}} identity Chat identity
 * @returns {{metadata: object, messages: any[]}|null}
 */
export function getWorkspaceChatSnapshot(identity) {
    const store = getWorkspaceCacheStore();
    const key = getChatCacheKey(identity);
    if (!store || !key || !store.chats.has(key)) return null;

    const snapshot = store.chats.get(key);
    store.chats.delete(key);
    store.chats.set(key, snapshot);
    return cloneValue(snapshot);
}

/**
 * Keeps the latest in-memory form of a chat available for a warm tab switch.
 * @param {{kind: string, ownerId: string, chatId: string}} identity Chat identity
 * @param {object} metadata Chat metadata
 * @param {any[]} messages Chat messages
 */
export function setWorkspaceChatSnapshot(identity, metadata, messages) {
    const store = getWorkspaceCacheStore();
    const key = getChatCacheKey(identity);
    if (!store || !key || !Array.isArray(messages)) return;

    store.chats.delete(key);
    store.chats.set(key, cloneValue({ metadata: metadata || {}, messages }));
    while (store.chats.size > MAX_CACHED_CHATS) {
        store.chats.delete(store.chats.keys().next().value);
    }
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
