// Tool-call `action` handlers for the visible World Sim run. These execute when a
// `select_characters` / `world_initialize` / `world_update` tool call is run from the host chat (auto, or
// on click when `tool_click_to_execute` is on). They apply world state and chain the
// run forward (selector -> updater). See [[world-sim-run-pipeline]].

import {
    getLocations,
    getRoster,
    getRosterCharacter,
    setCharacterStrings,
    pushCharacterHistory,
    saveWorldSimState,
    ensureLocationRegion,
    captureCurrentWorldSnapshot,
    hydrateCurrentWorldSnapshot,
    commitWorldRevision,
    findRosterIdByName,
} from './state.js';
import { getRun, updateRun, endRun } from './run-context.js';
import { applyWorldUpdate } from './llm.js';
import { renderAll } from './ui.js';
import * as worldSimMap from './map.js';
import { clearWorldSimToolScope } from './tools.js';

/**
 * Handles a `select_characters` tool execution. The run driver prepares card summaries
 * and starts the updater only after the selector generation fully resolves.
 * @param {object} args
 * @returns {Promise<string>} Tool result text shown in chat.
 */
export async function onSelectCharacters(args) {
    const roster = getRoster();
    const run = getRun();
    const excluded = new Set(Array.isArray(run?.excludedCharacterIds) ? run.excludedCharacterIds : []);
    const required = [...new Set(Array.isArray(run?.includedCharacterIds) ? run.includedCharacterIds : [])]
        .filter(id => !excluded.has(id));
    const selected = [...new Set(Array.isArray(args.characterIds) ? args.characterIds : [])]
        .filter(id => !excluded.has(id));
    const ids = [...new Set([...required, ...selected])]
        .filter(id => roster.characters[id]?.included && (run?.baseSnapshot?.characters?.[id]?.initialized ?? roster.characters[id]?.initialized))
        .slice(0, 10);

    updateRun({ characterIds: ids, selectorResult: { characterIds: ids } });

    if (!ids.length) {
        clearWorldSimToolScope();
        endRun();
        return 'No characters selected; nothing to update.';
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
    if (!run?.baseSnapshot || !run?.baseRevisionId || !run?.expectedHeadId) throw new Error('Missing initialization revision context');
    const liveSnapshot = captureCurrentWorldSnapshot();
    hydrateCurrentWorldSnapshot(run.baseSnapshot);
    applyInitialize(run, update, args);

    const charId = run?.characterIds?.[0] || update.characterId;
    const characterName = getRosterCharacter(charId)?.name || charId || 'character';
    const missing = ['activity', 'plan', 'summary', 'location', 'x', 'y']
        .filter(k => args?.[k] === undefined || args?.[k] === null || args?.[k] === '');
    if (missing.length) {
        console.warn(`[world-sim] Initialized ${charId} with MISSING fields: ${missing.join(', ')}`);
    } else {
        console.log(`[world-sim] Initialized ${charId} successfully (no missing fields).`);
    }

    const resultSnapshot = captureCurrentWorldSnapshot();
    hydrateCurrentWorldSnapshot(liveSnapshot);
    try {
        await commitWorldRevision({
            source: 'initialize',
            summary: `Initialized ${characterName}`,
            parentId: run.baseRevisionId,
            expectedHeadId: run.expectedHeadId,
            snapshot: resultSnapshot,
            generation: { cycleId: run.cycleId },
            eventBatch: {
                event: {
                    kind: 'initialize',
                    characterIds: [charId],
                    summaries: { [charId]: String(characterName) },
                },
            },
        });
    } catch (error) {
        clearWorldSimToolScope();
        endRun({ status: 'failed', reason: error.message, error });
        throw error;
    }
    const liveCharacter = getRosterCharacter(charId);
    if (liveCharacter) liveCharacter.included = true;
    await saveWorldSimState();
    await renderAll();
    if (charId) worldSimMap.selectCharacterOnMap(charId, { focus: false });
    clearWorldSimToolScope();
    endRun({ status: 'complete', mode: 'initialize', characterIds: charId ? [charId] : [] });

    return 'Initialized 1 character.';
}

/**
 * Handles a `world_update` tool execution: applies the update to world state, records the
 * revision, refreshes the UI, and ends the run.
 * @param {object} args
 * @returns {Promise<string>} Tool result text shown in chat.
 */
export async function onWorldUpdate(args) {
    const run = getRun();
    if (!run?.baseSnapshot || !run?.baseRevisionId || !run?.expectedHeadId) throw new Error('Missing world revision context');
    const mode = run?.mode || 'continue';
    const updates = normalizeWorldUpdates(run, args);
    if (mode === 'commit') {
        const committedIds = new Set(updates.map(update => update.characterId));
        const missingInitialIds = (run.characterIds || []).filter(id => !committedIds.has(id));
        if (!updates.length || missingInitialIds.length) {
            throw new Error(`Scene commit omitted required character updates${missingInitialIds.length ? `: ${missingInitialIds.join(', ')}` : ''}`);
        }
    }
    const normalizedArgs = { ...args, updates };

    const liveSnapshot = captureCurrentWorldSnapshot();
    hydrateCurrentWorldSnapshot(run.baseSnapshot);
    applyLocationRegistrations(normalizedArgs, { onlyNew: mode === 'commit' });
    applyWorldUpdate({ updates });
    const resultSnapshot = captureCurrentWorldSnapshot();
    hydrateCurrentWorldSnapshot(liveSnapshot);
    const summary = updates.map(update => String(update?.summary || '').trim()).filter(Boolean).join(' ');
    try {
        await commitWorldRevision({
            source: mode === 'branch' ? 'guided-branch' : mode === 'guided' ? 'guided' : mode === 'commit' ? 'scene' : 'fast-forward',
            summary,
            parentId: run.baseRevisionId,
            expectedHeadId: run.expectedHeadId,
            allowHistoricalParent: mode === 'branch' || mode === 'commit',
            snapshot: resultSnapshot,
            generation: { cycleId: run.cycleId, dice: run.dice || {}, guidance: run.guidance || undefined },
            eventBatch: {
                event: {
                    kind: 'event',
                    characterIds: updates.map(update => update.characterId).filter(Boolean),
                    summaries: Object.fromEntries(updates
                        .filter(update => update.characterId)
                        .map(update => [update.characterId, String(update.summary || '')])),
                    generation: run.guidance ? {
                        guidance: run.guidance,
                        includedCharacterIds: run.includedCharacterIds || [],
                        excludedCharacterIds: run.excludedCharacterIds || [],
                        exactCharacterSelection: !!run.exactCharacterSelection,
                    } : undefined,
                },
            },
        });
    } catch (error) {
        clearWorldSimToolScope();
        endRun({ status: 'failed', reason: error.message, error });
        throw error;
    }
    await renderAll();
    clearWorldSimToolScope();
    endRun({ status: 'complete', mode, characterIds: updates.map(update => update.characterId).filter(Boolean) });

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

    if (run?.mode === 'commit') {
        const roster = getRoster();
        const seen = new Set();
        return rawUpdates.slice(0, 10).map((update, index) => {
            const requestedId = String(update?.characterId || '');
            const resolvedId = roster.characters[requestedId]
                ? requestedId
                : findRosterIdByName(requestedId) || runIds[index] || null;
            const isInitialized = resolvedId
                && roster.characters[resolvedId]?.included
                && (run?.baseSnapshot?.characters?.[resolvedId]?.initialized ?? roster.characters[resolvedId]?.initialized);
            if (!isInitialized || seen.has(resolvedId)) return null;
            seen.add(resolvedId);
            const worldUpdate = { ...(update || {}) };
            delete worldUpdate.interactedWith;
            return { ...worldUpdate, characterId: resolvedId };
        }).filter(Boolean);
    }

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
function applyLocationRegistrations(args, { onlyNew = false } = {}) {
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
        if (onlyNew && existedBefore) continue;
        const hasEdges = [left, bottom, right, top].every(Number.isFinite) && right > left && top > bottom;
        ensureLocationRegion(String(loc.name), hasEdges ? {
            left,
            right,
            bottom,
            top,
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
    const location = String(update.location || '');
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
    pushCharacterHistory(targetId, 'location', location);
    pushCharacterHistory(targetId, 'activity', String(update.activity || ''));
    pushCharacterHistory(targetId, 'plan', String(update.plan || ''));
    pushCharacterHistory(targetId, 'summary', String(update.summary || ''));

    const char = getRosterCharacter(targetId);
    if (char) {
        char.initialized = true;
        char.included = true;
    }
}
