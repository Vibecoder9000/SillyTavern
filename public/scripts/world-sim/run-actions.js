// Tool-call `action` handlers for the visible World Sim run. These execute when a
// `select_characters` / `world_initialize` / `world_update` tool call is run from the host chat (auto, or
// on click when `tool_click_to_execute` is on). They apply world state and chain the
// run forward (selector -> updater). See [[world-sim-run-pipeline]].

import {
    getState,
    getLocations,
    getRosterCharacter,
    setCharacterStrings,
    pushCharacterHistory,
    updateState,
    appendCycle,
    saveSnapshot,
    saveWorldSimState,
    ensureLocationRegion,
    locationFromCoords,
} from './state.js';
import { getRun, updateRun, endRun } from './run-context.js';
import { applyWorldUpdate } from './llm.js';
import { renderAll, updateWorldClock } from './ui.js';
import * as worldSimMap from './map.js';
import { clearWorldSimToolScope } from './tools.js';

/**
 * Handles a `select_characters` tool execution: records the selection only. The updater
 * step is fired by the run driver (runCycle) AFTER this tool execution fully resolves, so
 * the updater's fresh chat isn't created while ST is still executing this tool on the
 * selector chat. See [[world-sim-run-pipeline]].
 * @param {object} args
 * @returns {Promise<string>} Tool result text shown in chat.
 */
export async function onSelectCharacters(args) {
    const ids = Array.isArray(args.characterIds) ? args.characterIds.slice(0, 5) : [];

    updateRun({ characterIds: ids, selectorResult: { characterIds: ids } });

    if (!ids.length) {
        clearWorldSimToolScope();
        endRun();
        return 'No characters selected; nothing to update.';
    }

    const run = getRun();
    if (run?.needsUpdaterChain) {
        // The selector fired as a retry after runCycle already returned past the chaining point.
        // Chain to the updater here so the tick completes. Deferred so ST finishes processing
        // this tool action before the updater opens a fresh chat.
        updateRun({ needsUpdaterChain: false });
        const capturedIds = ids;
        setTimeout(async () => {
            try {
                const { activateWorldSimToolScope, WORLD_UPDATE } = await import('./tools.js');
                const { fireUpdater } = await import('./llm.js');
                activateWorldSimToolScope([WORLD_UPDATE]);
                await fireUpdater(capturedIds);
                // If the updater didn't call the tool, leave scope/run alive for another retry.
            } catch (error) {
                console.error('World Sim updater failed after selector retry:', error);
                clearWorldSimToolScope();
                endRun();
            }
        }, 0);
    }

    return `Selected: ${ids.join(', ')}`;
}

/**
 * Handles a `world_initialize` tool execution: applies the starting state for one
 * character, refreshes the UI, records the initialization cycle, and ends the run.
 * @param {object} args
 * @returns {Promise<string>} Tool result text shown in chat.
 */
export async function onWorldInitialize(args) {
    const run = getRun();
    const update = normalizeInitialization(run, args);
    applyInitialize(run, update, args);

    const charId = run?.characterIds?.[0] || update.characterId;
    const missing = ['activity', 'plan', 'summary', 'x', 'y']
        .filter(k => args?.[k] === undefined || args?.[k] === null || args?.[k] === '');
    if (missing.length) {
        console.warn(`[world-sim] Initialized ${charId} with MISSING fields: ${missing.join(', ')}`);
    } else {
        console.log(`[world-sim] Initialized ${charId} successfully (no missing fields).`);
    }

    await saveWorldSimState();
    await renderAll();
    updateWorldClock();
    if (charId) worldSimMap.selectCharacterOnMap(charId, { focus: false });
    await recordCycle(run, {
        updates: [update],
        globalMinutesPassed: 0,
    }, getState().tick);
    clearWorldSimToolScope();
    endRun();

    return 'Initialized 1 character.';
}

/**
 * Handles a `world_update` tool execution: applies the update to world state, advances
 * the clock when appropriate, records the cycle, refreshes the UI, and ends the run.
 * @param {object} args
 * @returns {Promise<string>} Tool result text shown in chat.
 */
export async function onWorldUpdate(args) {
    const run = getRun();
    const mode = run?.mode || 'tick';
    const updates = normalizeWorldUpdates(run, args);
    const normalizedArgs = { ...args, updates };

    applyLocationRegistrations(normalizedArgs);
    const tick = getState().tick;
    if (run?.snapshot) await saveSnapshot(run.cycleId, run.snapshot);
    applyWorldUpdate({ updates, globalMinutesPassed: mode === 'commit' ? 0 : normalizedArgs.globalMinutesPassed }, tick);
    if (mode === 'tick') {
        updateState({ tick: tick + 1, lastRunAt: new Date().toISOString() });
        await recordCycle(run, normalizedArgs, tick);
    } else if (mode === 'commit') {
        // Re-record the zoomed event under its ORIGINAL cycleId + tick so it supersedes the
        // coarse version on load (loadCycles keeps the last line per cycleId). No tick advance.
        await recordCycle(run, normalizedArgs, Number.isFinite(run?.tick) ? run.tick : tick);
    }

    await saveWorldSimState();
    await renderAll();
    updateWorldClock();
    clearWorldSimToolScope();
    endRun();

    return `Updated ${updates.length} character(s).`;
}

/**
 * Attaches authoritative character IDs from the run context so the model does not need
 * to echo opaque IDs back to us.
 * @param {object|null} run
 * @param {object} args
 * @returns {object[]}
 */
function normalizeWorldUpdates(run, args) {
    const rawUpdates = Array.isArray(args.updates) ? args.updates : [];
    const runIds = Array.isArray(run?.characterIds) ? run.characterIds : [];

    return rawUpdates.slice(0, runIds.length).map((update, index) => ({
        ...update,
        characterId: runIds[index],
    }));
}

/**
 * Attaches the single initialization target ID from the run context so the model only
 * needs to provide state, not identity.
 * @param {object|null} run
 * @param {object} args
 * @returns {object}
 */
function normalizeInitialization(run, args) {
    return {
        ...args,
        characterId: run?.characterIds?.[0] || args?.characterId,
    };
}

/**
 * Registers the `locations` array from a world-sim tool call, if present.
 * @param {object} args
 */
function applyLocationRegistrations(args) {
    const list = Array.isArray(args.locations) ? args.locations : [];
    const createdIds = [];
    for (const loc of list) {
        if (!loc || !loc.name) continue;
        const left = Number(loc.left);
        const bottom = Number(loc.bottom);
        const right = Number(loc.right);
        const top = Number(loc.top);
        const id = String(loc.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const existedBefore = !!getLocations().locations?.[id];
        const hasEdges = [left, bottom, right, top].every(Number.isFinite) && right > left && top > bottom;
        ensureLocationRegion(String(loc.name), hasEdges ? {
            x: left,
            y: bottom,
            w: right - left,
            h: top - bottom,
            description: loc.description,
        } : { description: loc.description });
        if (!existedBefore && getLocations().locations?.[id]) createdIds.push(id);
    }
    return createdIds;
}

/**
 * Applies an initialization update: a single character gains its starting strings,
 * coordinates, and (from the card) a fixed map region, and is marked initialized.
 * @param {object|null} run
 * @param {object} update
 * @param {object} args  Full tool args (may include `locations`)
 */
function applyInitialize(run, update, args) {
    const createdIds = applyLocationRegistrations(args);

    const id = run?.characterIds?.[0];
    if (!update) return;

    // Always write to the roster ID from the run context, not whatever string the model used.
    const targetId = id || update.characterId;
    const coords = {};
    if (Number.isFinite(Number(update.x))) coords.x = Number(update.x);
    if (Number.isFinite(Number(update.y))) coords.y = Number(update.y);
    // Derive location from coords (most reliable); fall back to the model's text if no region matches.
    const location = locationFromCoords(coords.x, coords.y) || String(update.location || '');
    if (location) {
        const id = String(location).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const existedBefore = !!getLocations().locations?.[id];
        ensureLocationRegion(location);
        if (!existedBefore && getLocations().locations?.[id]) createdIds.push(id);
    }

    if (createdIds.length) worldSimMap.markJustInitializedLocations?.(createdIds);

    setCharacterStrings(targetId, {
        location,
        activity: String(update.activity || ''),
        plan: String(update.plan || ''),
        summary: String(update.summary || ''),
        ...coords,
    });
    const tick = getState().tick;
    pushCharacterHistory(targetId, 'location', location, tick);
    pushCharacterHistory(targetId, 'activity', String(update.activity || ''), tick);
    pushCharacterHistory(targetId, 'plan', String(update.plan || ''), tick);
    pushCharacterHistory(targetId, 'summary', String(update.summary || ''), tick);

    const char = getRosterCharacter(targetId);
    if (char) {
        char.initialized = true;
        char.included = true;
    }
}

/**
 * @param {object|null} run
 * @param {object} updaterArgs
 * @param {number} tick The tick number at which this cycle ran (before any increment).
 */
async function recordCycle(run, updaterArgs, tick) {
    const state = getState();
    const selector = run?.selectorResult || { characterIds: run?.characterIds || [] };
    const updates = Array.isArray(updaterArgs.updates) ? updaterArgs.updates : [];
    const summary = updates
        .map(update => String(update?.summary || '').trim())
        .filter(Boolean)
        .join(' ');
    await appendCycle({
        cycleId: run?.cycleId,
        tick: tick ?? state.tick,
        inWorldMinutes: state.inWorldMinutes || 0,
        selector: {
            preset: '',
            characterIds: selector.characterIds || [],
            reason: '',
            ok: true,
            error: null,
            chatId: run?.cycleId,
            promptTokens: 0,
            completionTokens: 0,
        },
        updater: {
            preset: '',
            dice: {},
            globalMinutesPassed: Number(updaterArgs.globalMinutesPassed) || 0,
            updates,
            summary,
            ok: true,
            error: null,
            chatId: run?.cycleId,
            promptTokens: 0,
            completionTokens: 0,
        },
    });
}
