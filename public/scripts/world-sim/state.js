import { getRequestHeaders } from '../../script.js';

const API_URL = '/api/world-sim';

/**
 * @typedef {object} WorldSimConfig
 * @property {number} tickIntervalMinutes
 * @property {number} autoPauseIdleMinutes
 * @property {number} historyEntriesPerCharacter
 * @property {number} targetWordsPerEntry
 * @property {number} diceSides
 * @property {string} defaultLocation
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
 * @property {number} tick
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
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [w]
 * @property {number} [h] Internal rectangle height. The LLM-facing prompts/tools use left/bottom/right/top edges instead.
 * @property {string[]} adjacent
 */

/**
 * @typedef {object} WorldSimState
 * @property {number} tick
 * @property {number} inWorldMinutes
 * @property {string|null} lastRunAt
 * @property {string|null} nextTickAt
 * @property {boolean} paused
 * @property {boolean} idlePaused
 * @property {Record<string, WorldSimStrings>} characters
 */

/**
 * @typedef {object} WorldSimCycle
 * @property {string} cycleId
 * @property {number} tick
 * @property {object} selector
 * @property {object} updater
 */

/** @type {WorldSimConfig} */
let config = {};
/** @type {WorldSimRoster} */
let roster = { characters: {} };
/** @type {WorldSimLocations} */
let locations = { locations: {} };
/** @type {WorldSimState} */
let state = {};
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
    locations = data.locations;
    state = data.state;
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
        body: JSON.stringify({ config, roster, locations, state }),
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
    locations = data.locations;
    state = data.state;
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
 * @param {{x:number,y:number,w:number,h:number,description?:string}} [box]
 * @returns {WorldSimLocation|undefined}
 */
export function ensureLocationRegion(name, box) {
    if (!name) return undefined;
    const id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!id) return undefined;
    const hasBox = box && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(Number(box[k])));
    const description = (box && typeof box.description === 'string' && box.description) || undefined;
    const existing = locations.locations[id];
    if (existing) {
        if (hasBox && !Number.isFinite(existing.x)) {
            Object.assign(existing, { x: Number(box.x), y: Number(box.y), w: Math.max(1, Number(box.w)), h: Math.max(1, Number(box.h)) });
        }
        if (description && !existing.description) existing.description = description;
        return existing;
    }
    locations.locations[id] = hasBox
        ? { name, description, x: Number(box.x), y: Number(box.y), w: Math.max(1, Number(box.w)), h: Math.max(1, Number(box.h)), adjacent: [] }
        : { name, description, adjacent: [] };
    return locations.locations[id];
}

/**
 * Returns the name of the first location region that contains the given world coordinates,
 * or null if none match. Used to derive a character's location from their map position.
 * @param {number} x
 * @param {number} y
 * @returns {string|null}
 */
export function locationFromCoords(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const loc of Object.values(locations.locations)) {
        if (!Number.isFinite(loc.x)) continue;
        if (x >= loc.x && x <= loc.x + loc.w && y >= loc.y && y <= loc.y + loc.h) {
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
    char.strings = { location: '', activity: '', plan: '', summary: '' };
    char.history = createEmptyCharacterHistory();
    char.initialized = false;
    return true;
}

/**
 * @param {string} characterId
 * @param {keyof WorldSimStrings} key
 * @param {string} text
 * @param {number} tick
 */
export function pushCharacterHistory(characterId, key, text, tick) {
    const char = roster.characters[characterId];
    if (!char) return;
    char.history[key].push({ tick, text });
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
 * Resolves a character's location/activity/plan/summary AS OF a given tick, so a zoomed-in
 * scene reflects the event it focuses on rather than the latest world state. Falls back to
 * the current live state for any field whose tick-stamped history has rolled off (history is
 * a capped window) or when no tick is supplied.
 * @param {string} characterId
 * @param {number|null} [tick]
 * @returns {{ location: string, activity: string, plan: string, summary: string, x: number|undefined, y: number|undefined }}
 */
export function getCharacterStateAtTick(characterId, tick = null) {
    const cur = state.characters[characterId] || {};
    const base = {
        location: cur.location || '',
        activity: cur.activity || '',
        plan: cur.plan || '',
        summary: cur.summary || '',
        x: cur.x,
        y: cur.y,
    };
    const char = roster.characters[characterId];
    if (!char || !Number.isFinite(tick)) return base;

    const at = (key) => {
        const arr = char.history?.[key] || [];
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]?.tick === tick) return arr[i].text;
        }
        return undefined;
    };
    const location = at('location');
    const activity = at('activity');
    const plan = at('plan');
    const summary = at('summary');
    // If nothing at this tick survives in the window, the live state is our best guess.
    if ([location, activity, plan, summary].every(v => v === undefined)) return base;
    return {
        location: location ?? base.location,
        activity: activity ?? base.activity,
        plan: plan ?? base.plan,
        summary: summary ?? base.summary,
        x: base.x,
        y: base.y,
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
 * Records that two characters interacted on a given tick. Stored on the live state entry
 * (not roster history) so it survives in snapshots and is queryable for scene context.
 * The caller mirrors the pair, recording on both participants.
 * @param {string} characterId
 * @param {string} withId
 * @param {number} tick
 * @param {string} [note]
 */
export function pushCharacterInteraction(characterId, withId, tick, note = '') {
    const cur = state.characters[characterId];
    if (!cur || !withId || withId === characterId) return;
    if (!Array.isArray(cur.interactions)) cur.interactions = [];
    cur.interactions.push({ tick, withId, note: String(note || '') });
    const limit = (config.historyEntriesPerCharacter ?? 5) * 4;
    while (cur.interactions.length > limit) cur.interactions.shift();
}

/**
 * Returns the unique ids of characters this character interacted with on or after
 * `tick - withinTicks`. Empty when nothing is tracked.
 * @param {string} characterId
 * @param {number} [withinTicks]
 * @returns {string[]}
 */
export function getRecentInteractionPartnerIds(characterId, withinTicks = 3) {
    const cur = state.characters[characterId];
    if (!cur || !Array.isArray(cur.interactions)) return [];
    const minTick = (state.tick || 0) - withinTicks;
    const ids = new Set();
    for (const it of cur.interactions) {
        if (it.tick >= minTick && it.withId) ids.add(it.withId);
    }
    return [...ids];
}

/**
 * @typedef {object} WorldSimScene
 * @property {string} sceneId      Stable id (we reuse the ST group id).
 * @property {string} groupId      The backing ST group's id.
 * @property {string|null} cycleId The tick this scene zooms into, if any.
 * @property {number|null} tick
 * @property {string[]} characterIds
 * @property {string} title
 * @property {string} createdAt
 * @property {boolean} committed    Whether this scene has been committed back to world state.
 */

/**
 * Scenes are roleplay group chats that "zoom in" on a tick. They are tracked here so the
 * Conversations tab can list them and so their backing groups can be hidden from the main
 * character grid (see hiddenGroupIds in script.js).
 * @returns {WorldSimScene[]}
 */
export function getScenes() {
    if (!Array.isArray(state.scenes)) state.scenes = [];
    return state.scenes;
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
 * @param {WorldSimCycle} cycle
 * @returns {Promise<void>}
 */
export async function appendCycle(cycle) {
    const response = await fetch(`${API_URL}/cycles`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ append: cycle }),
    });
    if (!response.ok) throw new Error('Failed to append cycle');
}

/**
 * @returns {Promise<WorldSimCycle[]>}
 */
export async function loadCycles() {
    const response = await fetch(`${API_URL}/cycles`, {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (!response.ok) return [];
    const raw = await response.json();
    // cycles.jsonl is append-only. A committed scene re-appends its event under the SAME
    // cycleId, so a later line supersedes the earlier one ("replace the event"). Keep the
    // last line per cycleId, then order by in-world tick.
    const byId = new Map();
    let fallback = 0;
    for (const c of Array.isArray(raw) ? raw : []) {
        if (!c) continue;
        byId.set(c.cycleId || `__noid_${fallback++}`, c);
    }
    return [...byId.values()].sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
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
 * @param {string} cycleId
 * @param {object} snapshot
 * @returns {Promise<void>}
 */
export async function saveSnapshot(cycleId, snapshot) {
    const response = await fetch(`${API_URL}/snapshot/save`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ cycleId, snapshot }),
    });
    if (!response.ok) throw new Error('Failed to save snapshot');
}

/**
 * @param {string} cycleId
 * @returns {Promise<object>}
 */
export async function loadSnapshot(cycleId) {
    const response = await fetch(`${API_URL}/snapshot/load`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ cycleId }),
    });
    if (!response.ok) return {};
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
