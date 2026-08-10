import { getRequestHeaders } from '../../script.js';
import {
    captureWorldSnapshot,
    commitRevision,
    diffWorldSnapshots,
    editRevision,
    getHeadRevisionId,
    getHeadSnapshot,
    getRevisionIndex,
    hydrateWorldSnapshot,
    initializeRevisions,
    loadRevisionSnapshot,
    propagateLocationBounds,
    saveCurrentSnapshot,
} from './revisions.js';
import { getEventHistory, initializeEventHistory } from './event-history.js';

const API_URL = '/api/world-sim';

/**
 * @typedef {object} WorldSimConfig
 * @property {number} historyEntriesPerCharacter
 * @property {number} targetWordsPerEntry
 * @property {number} diceSides
 * @property {string} defaultLocation
 * @property {boolean} summaryPaused
 */

/**
 * @typedef {object} WorldSimRoster
 * @property {Record<string, WorldSimCharacter>} characters
 */

/**
 * @typedef {object} WorldSimCharacter
 * @property {string} id
 * @property {string} name
 * @property {string} avatar
 * @property {boolean} included
 * @property {boolean} priority
 * @property {WorldSimStrings} strings
 * @property {WorldSimHistory} history
 * @property {boolean} initialized
 */

/**
 * @typedef {object} WorldSimStrings
 * @property {string} location
 * @property {string} activity
 * @property {string} plan
 * @property {string} summary
 */

/**
 * @typedef {object} WorldSimHistory
 * @property {WorldSimHistoryEntry[]} location
 * @property {WorldSimHistoryEntry[]} activity
 * @property {WorldSimHistoryEntry[]} plan
 * @property {WorldSimHistoryEntry[]} summary
 */

/**
 * @typedef {object} WorldSimHistoryEntry
 * @property {string} text
 */

/**
 * @typedef {object} WorldSimLocations
 * @property {Record<string, WorldSimLocation>} locations
 */

/**
 * @typedef {object} WorldSimLocation
 * @property {string} name
 * @property {string} [description]
 * @property {number} [left]
 * @property {number} [right]
 * @property {number} [bottom]
 * @property {number} [top]
 * @property {string[]} adjacent
 */

/**
 * @typedef {object} WorldSimState
 * @property {Record<string, WorldSimStrings>} characters
 */

/** @type {WorldSimConfig} */
let config = {};
/** @type {WorldSimRoster} */
let roster = { characters: {} };
/** @type {WorldSimLocations} */
let locations = { locations: {} };
/** @type {WorldSimState} */
let state = {};
/** @type {WorldSimScene[]} */
let conversations = [];
let hasLoadedWorldSimState = false;

/**
 * Loads world-sim state from the server.
 * @returns {Promise<void>}
 */
export async function loadWorldSimState() {
    const response = await fetch(`${API_URL}/load`, {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (!response.ok) throw new Error('Failed to load world-sim state');
    const data = await response.json();
    config = data.config;
    roster = data.roster;
    locations = { locations: {} };
    state = { characters: {} };
    conversations = Array.isArray(data.conversations) ? data.conversations : [];
    initializeRevisions(data.revisionIndex, data.headSnapshot);
    initializeEventHistory(data.eventHistory);
    if (data.headSnapshot) hydrateWorldSnapshot(data.headSnapshot, roster, locations, state);
    hasLoadedWorldSimState = true;
}

/**
 * Saves world-sim state to the server.
 * @returns {Promise<void>}
 */
export async function saveWorldSimState() {
    // Avoid overwriting persisted data with the module's bootstrap placeholders
    // if an unload or timer action fires before the initial load completes.
    if (!hasLoadedWorldSimState) return;
    const response = await fetch(`${API_URL}/save`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ config, roster: capturePersistentRoster(), conversations }),
    });
    if (!response.ok) throw new Error('Failed to save world-sim state');
}

/**
 * Resets all persisted world-sim data on the server and reloads the local caches.
 * @returns {Promise<void>}
 */
export async function resetWorldSimState() {
    const response = await fetch(`${API_URL}/reset`, {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (!response.ok) throw new Error('Failed to reset world-sim state');
    const data = await response.json();
    config = data.config;
    roster = data.roster;
    locations = { locations: {} };
    state = { characters: {} };
    conversations = Array.isArray(data.conversations) ? data.conversations : [];
    initializeRevisions(data.revisionIndex, data.headSnapshot);
    initializeEventHistory(data.eventHistory);
    if (data.headSnapshot) hydrateWorldSnapshot(data.headSnapshot, roster, locations, state);
    hasLoadedWorldSimState = true;
}

/**
 * @returns {WorldSimConfig}
 */
export function getConfig() {
    return config;
}

/**
 * @returns {WorldSimRoster}
 */
export function getRoster() {
    return roster;
}

/**
 * @returns {WorldSimLocations}
 */
export function getLocations() {
    return locations;
}

/**
 * @returns {WorldSimState}
 */
export function getState() {
    return state;
}

/**
 * @param {Partial<WorldSimConfig>} updates
 */
export function updateConfig(updates) {
    Object.assign(config, updates);
}

/**
 * @param {Partial<WorldSimRoster>} updates
 */
export function updateRoster(updates) {
    Object.assign(roster, updates);
}

/**
 * @param {Partial<WorldSimLocations>} updates
 */
export function updateLocations(updates) {
    Object.assign(locations, updates);
}

/**
 * Creates (or fills in geometry/description for) a named location region.
 * @param {string} name
 * @param {{left:number,right:number,bottom:number,top:number,description?:string}} [box]
 * @returns {WorldSimLocation|undefined}
 */
export function ensureLocationRegion(name, box) {
    if (!name) return undefined;
    const id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!id) return undefined;
    const hasBox = box
        && ['left', 'right', 'bottom', 'top'].every(k => Number.isFinite(Number(box[k])))
        && Number(box.right) > Number(box.left)
        && Number(box.top) > Number(box.bottom);
    const description = (box && typeof box.description === 'string' && box.description) || undefined;
    const existing = locations.locations[id];
    if (existing) {
        if (hasBox && !Number.isFinite(existing.left)) {
            Object.assign(existing, {
                left: Number(box.left), right: Number(box.right),
                bottom: Number(box.bottom), top: Number(box.top),
            });
        }
        if (description && !existing.description) existing.description = description;
        return existing;
    }
    locations.locations[id] = hasBox
        ? {
            name, description,
            left: Number(box.left), right: Number(box.right),
            bottom: Number(box.bottom), top: Number(box.top),
            adjacent: [],
        }
        : { name, description, adjacent: [] };
    return locations.locations[id];
}

/**
 * Returns the name of the first location region that contains the given world coordinates,
 * or null if none match. This is a map hit-test helper; semantic character location is
 * stored independently in the character state.
 * @param {number} x
 * @param {number} y
 * @returns {string|null}
 */
export function locationFromCoords(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const loc of Object.values(locations.locations)) {
        if (![loc.left, loc.right, loc.bottom, loc.top].every(Number.isFinite)) continue;
        if (x >= loc.left && x <= loc.right && y >= loc.bottom && y <= loc.top) {
            return loc.name;
        }
    }
    return null;
}

/**
 * @param {Partial<WorldSimState>} updates
 */
export function updateState(updates) {
    Object.assign(state, updates);
}

/**
 * @param {string} characterId
 * @returns {WorldSimCharacter|undefined}
 */
export function getRosterCharacter(characterId) {
    return roster.characters[characterId];
}

/**
 * @param {string} characterId
 * @returns {WorldSimStrings|undefined}
 */
export function getCharacterStrings(characterId) {
    return state.characters[characterId];
}

/**
 * @param {string} characterId
 * @param {WorldSimStrings} strings
 */
export function setCharacterStrings(characterId, strings) {
    if (!state.characters[characterId]) state.characters[characterId] = { location: '', activity: '', plan: '', summary: '' };
    Object.assign(state.characters[characterId], strings);
}

export { getEventHistory, getHeadRevisionId, getRevisionIndex, loadRevisionSnapshot };

export function captureCurrentWorldSnapshot() {
    return captureWorldSnapshot(roster, locations, state);
}

export function hydrateCurrentWorldSnapshot(snapshot) {
    hydrateWorldSnapshot(snapshot, roster, locations, state);
}

export async function saveCurrentWorldSnapshot() {
    await saveCurrentSnapshot(captureCurrentWorldSnapshot());
    await saveWorldSimState();
}

export async function saveLocationBounds(locationId, bounds, revisionId = getHeadRevisionId()) {
    const revision = getRevisionIndex()?.revisions?.[revisionId];
    if (!revision) throw new Error('World revision history is not initialized');
    const result = await propagateLocationBounds({
        revisionId,
        expectedSnapshotFilename: revision.snapshotFilename,
        locationId,
        bounds,
    });
    return result;
}

export async function commitWorldRevision({
    source = 'manual',
    summary = 'World state changed',
    generation,
    parentId = getHeadRevisionId(),
    expectedHeadId = getHeadRevisionId(),
    allowHistoricalParent = false,
    snapshot = captureCurrentWorldSnapshot(),
    eventBatch,
} = {}) {
    if (!parentId || !expectedHeadId) throw new Error('World revision history is not initialized');
    const before = parentId === getHeadRevisionId() ? getHeadSnapshot() : await loadRevisionSnapshot(parentId);
    const changes = diffWorldSnapshots(before, snapshot);
    let revision;
    try {
        revision = await commitRevision({
            parentId,
            expectedHeadId,
            snapshot,
            allowHistoricalParent,
            metadata: {
                source,
                summary,
                ...changes,
                generation,
            },
            eventBatch,
        });
    } catch (error) {
        if (error.headId) {
            const authoritative = await loadRevisionSnapshot(error.headId);
            hydrateCurrentWorldSnapshot(authoritative);
            await saveWorldSimState();
        }
        throw error;
    }
    hydrateCurrentWorldSnapshot(snapshot);
    await saveWorldSimState();
    return revision;
}

/**
 * Replaces one revision's contents without changing its identity or activating a historical node.
 * @param {{revisionId:string, expectedSnapshotFilename:string, snapshot:object, summary?:string}} edit
 * @returns {Promise<object>}
 */
export async function editWorldRevision(edit) {
    const wasHead = edit.revisionId === getHeadRevisionId();
    const revision = await editRevision(edit);
    if (wasHead) hydrateCurrentWorldSnapshot(edit.snapshot);
    return revision;
}

/**
 * @returns {WorldSimHistory}
 */
export function createEmptyCharacterHistory() {
    return { location: [], activity: [], plan: [], summary: [] };
}

/**
 * Clears a single character's live world-sim state and initialization progress.
 * Leaves locations and global world-sim history untouched.
 * @param {string} characterId
 * @returns {boolean}
 */
export function resetCharacterWorldSimState(characterId) {
    const char = roster.characters[characterId];
    if (!char) return false;

    delete state.characters[characterId];
    char.history = createEmptyCharacterHistory();
    char.initialized = false;
    return true;
}

/**
 * @param {string} characterId
 * @param {keyof WorldSimStrings} key
 * @param {string} text
 */
export function pushCharacterHistory(characterId, key, text) {
    const char = roster.characters[characterId];
    if (!char) return;
    char.history[key].push({ text });
    const limit = config.historyEntriesPerCharacter ?? 5;
    if (char.history[key].length > limit) {
        char.history[key].shift();
    }
}

/**
 * @param {string} characterId
 * @param {keyof WorldSimStrings} key
 * @param {number} index
 * @param {string} text
 */
export function updateCharacterHistoryEntry(characterId, key, index, text) {
    const char = roster.characters[characterId];
    if (!char || !char.history[key][index]) return;
    char.history[key][index].text = text;
}

/**
 * Returns a character's current compact world state.
 * @param {string} characterId
 * @returns {{ location: string, activity: string, plan: string, summary: string, x: number|undefined, y: number|undefined }}
 */
export function getCharacterWorldState(characterId) {
    const cur = state.characters[characterId] || {};
    return {
        location: cur.location || '',
        activity: cur.activity || '',
        plan: cur.plan || '',
        summary: cur.summary || '',
        x: cur.x,
        y: cur.y,
    };
}

/**
 * Resolves a roster character id from a (case-insensitive) display name. Used to turn the
 * names the model reports in `interactedWith` back into stable ids.
 * @param {string} name
 * @returns {string|null}
 */
export function findRosterIdByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    for (const c of Object.values(roster.characters)) {
        if (String(c.name || '').trim().toLowerCase() === n) return c.id;
    }
    return null;
}

/**
 * Records that two characters interacted. Stored on the live state entry
 * (not roster history) so it survives in snapshots and is queryable for scene context.
 * The caller mirrors the pair, recording on both participants.
 * @param {string} characterId
 * @param {string} withId
 * @param {string} [note]
 */
export function pushCharacterInteraction(characterId, withId, note = '') {
    const cur = state.characters[characterId];
    if (!cur || !withId || withId === characterId) return;
    if (!Array.isArray(cur.interactions)) cur.interactions = [];
    cur.interactions.push({ withId, note: String(note || '') });
    const limit = (config.historyEntriesPerCharacter ?? 5) * 4;
    while (cur.interactions.length > limit) cur.interactions.shift();
}

/**
 * Returns unique ids from this character's most recent stored interactions.
 * @param {string} characterId
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getRecentInteractionPartnerIds(characterId, limit = 3) {
    const cur = state.characters[characterId];
    if (!cur || !Array.isArray(cur.interactions)) return [];
    const ids = new Set();
    for (const it of cur.interactions.slice(-Math.max(1, limit))) {
        if (it.withId) ids.add(it.withId);
    }
    return [...ids];
}

/**
 * @typedef {object} WorldSimScene
 * @property {string} sceneId      Stable id (we reuse the ST group id).
 * @property {string} groupId      The backing ST group's id.
 * @property {string|null} cycleId The originating generation id, if any.
 * @property {string|null} [baseRevisionId] The event state from which this scene was opened.
 * @property {string[]} characterIds
 * @property {string} title
 * @property {string} createdAt
 * @property {boolean} committed    Whether this scene has been committed back to world state.
 */

/**
 * Scenes are roleplay group chats that expand the current compact world state. They are tracked here so the
 * Conversations tab can list them and so their backing groups can be hidden from the main
 * character grid (see hiddenGroupIds in script.js).
 * @returns {WorldSimScene[]}
 */
export function getScenes() {
    return conversations;
}

/**
 * @param {string} sceneId
 * @returns {WorldSimScene|undefined}
 */
export function getScene(sceneId) {
    return getScenes().find(s => s.sceneId === sceneId);
}

/**
 * @param {string|null} cycleId
 * @returns {WorldSimScene|undefined}
 */
export function getSceneByCycle(cycleId) {
    if (!cycleId) return undefined;
    return getScenes().find(s => s.cycleId === cycleId);
}

/**
 * @param {WorldSimScene} scene
 * @returns {WorldSimScene}
 */
export function addScene(scene) {
    getScenes().push(scene);
    return scene;
}

/**
 * @param {string} sceneId
 * @param {Partial<WorldSimScene>} patch
 * @returns {WorldSimScene|undefined}
 */
export function updateScene(sceneId, patch) {
    const scene = getScene(sceneId);
    if (scene) Object.assign(scene, patch);
    return scene;
}

/**
 * @param {string} sceneId
 */
export function removeScene(sceneId) {
    const scenes = getScenes();
    const index = scenes.findIndex(s => s.sceneId === sceneId);
    if (index >= 0) scenes.splice(index, 1);
}

/**
 * @param {'selector-chats'|'updater-chats'} folder
 * @param {string} id
 * @param {object[]} messages
 * @returns {Promise<void>}
 */
export async function saveChat(folder, id, messages) {
    const response = await fetch(`${API_URL}/chat/save`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, id, messages }),
    });
    if (!response.ok) throw new Error('Failed to save chat');
}

/**
 * @param {'selector-chats'|'updater-chats'} folder
 * @param {string} id
 * @returns {Promise<object[]>}
 */
export async function loadChat(folder, id) {
    const response = await fetch(`${API_URL}/chat/load`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, id }),
    });
    if (!response.ok) return [];
    return await response.json();
}

/**
 * @param {'selector-chats'|'updater-chats'} folder
 * @returns {Promise<string[]>}
 */
export async function listChats(folder) {
    const response = await fetch(`${API_URL}/files/list`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder }),
    });
    if (!response.ok) return [];
    return await response.json();
}

function capturePersistentRoster() {
    const result = { ...roster, characters: {} };
    for (const [id, rawCharacter] of Object.entries(roster.characters || {})) {
        const character = {};
        for (const key of ['id', 'name', 'avatar', 'included', 'priority', 'cardContext']) {
            if (Object.hasOwn(rawCharacter, key)) character[key] = rawCharacter[key];
        }
        result.characters[id] = character;
    }
    return result;
}
