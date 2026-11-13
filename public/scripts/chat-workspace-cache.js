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

/** Drops every cached chat snapshot so the next load fetches from the server. */
export function clearWorkspaceChatSnapshots() {
    getWorkspaceCacheStore()?.chats.clear();
}

/**
 * Drops one chat's cached snapshot so the next load of it fetches from the server.
 * @param {{kind: string, ownerId: string, chatId: string}|null} identity Chat identity
 */
export function deleteWorkspaceChatSnapshot(identity) {
    const key = getChatCacheKey(identity);
    if (key) getWorkspaceCacheStore()?.chats.delete(key);
}

/**
 * Records the integrity slug the server rotated on a successful save, so a later
 * load from this snapshot does not send an outdated slug and fail the check.
 * @param {{kind: string, ownerId: string, chatId: string}} identity Chat identity
 * @param {string} integrity New integrity slug
 */
export function setWorkspaceChatSnapshotIntegrity(identity, integrity) {
    const store = getWorkspaceCacheStore();
    const key = getChatCacheKey(identity);
    const snapshot = store && key ? store.chats.get(key) : null;
    if (!snapshot || !integrity) return;
    snapshot.metadata = { ...snapshot.metadata, integrity };
}

/**
 * Reloads after an integrity conflict. Inside the workspace the whole shell is
 * reloaded: the snapshot cache lives on the shell window, and reloading only the
 * chat frame can leave the shell waiting on a boot handshake.
 */
export function reloadOutdatedChat() {
    clearWorkspaceChatSnapshots();
    const store = getWorkspaceCacheStore();
    const target = store ? window.parent : window;
    target.location.reload();
}

export function hasWorkspaceChatSnapshot(identity) {
    const store = getWorkspaceCacheStore();
    const key = getChatCacheKey(identity);
    return Boolean(store && key && store.chats.has(key));
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

    // A messages-only update keeps the cached metadata: dropping it would also drop
    // the integrity slug and make the next save from this snapshot look stale.
    const nextMetadata = metadata ?? store.chats.get(key)?.metadata ?? {};
    store.chats.delete(key);
    store.chats.set(key, cloneValue({ metadata: nextMetadata, messages }));
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
