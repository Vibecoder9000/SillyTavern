import {
    getRoster,
    getState,
    updateState,
    saveWorldSimState,
    getRosterCharacter,
    getScenes,
    getScene,
    getSceneByCycle,
    addScene,
    updateScene,
    removeScene,
    captureCurrentWorldSnapshot,
    getHeadRevisionId,
    loadRevisionSnapshot,
} from './state.js';
import { characters, eventSource, event_types, getRequestHeaders, hiddenGroupIds, printCharacters, setActiveGroup } from '../../script.js';
import { humanizedDateTime } from '../RossAscends-mods.js';
import { fireSelector, fireUpdater, fireInitialize, fireCommit, seedSceneOpening } from './llm.js';
import { activateWorldSimToolScope, clearWorldSimToolScope, SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE } from './tools.js';
import { isGenerationInProgress, openWorldCharacterChat } from './world-character.js';
import { beginRun, getRun, updateRun, pauseRun, endRun, generateCycleId } from './run-context.js';
import { ensureCharacterCardContext } from './card-summary.js';

/**
 * World Sim should keep the scoped tool available when the generation was merely stopped
 * before the tool executed. That lets the user retry/correct the same request.
 * @param {unknown} error
 * @returns {boolean}
 */
function wasGenerationStopped(error) {
    const message = String(error?.message || error || '');
    return error?.name === 'AbortError' || /\babort(?:ed|ing)?\b|\bstopp?(?:ed|ing)?\b/i.test(message);
}

/**
 * World Sim runs end only when the expected scoped tool executes. If the model answers
 * without calling that tool (or hallucinates some unrelated tool tag), the run would
 * otherwise stay active and make bulk initialize appear stalled.
 * @param {string} cycleId
 * @param {string} expectedToolName
 * @param {string} failureMessage
 * @returns {boolean} Whether the run was still active and had to be cleaned up.
 */
function failIfRunStillActive(cycleId, expectedToolName) {
    const run = getRun();
    if (!run || run.cycleId !== cycleId) {
        return false;
    }

    // Don't clear the scope or end the run — the user may reroll or correct this generation,
    // and the tool must remain visible for the retry. Cleanup happens when:
    //   - the retry succeeds (tool action fires → clears scope and ends run), or
    //   - a new run starts (activateWorldSimToolScope supersedes this one), or
    //   - the catch block fires on a hard error.
    console.warn(`World Sim run ${cycleId} completed without calling ${expectedToolName}.`);
    return true;
}

/** Waits for a tool result, or for another action to supersede this run. */
function waitForWorldSimTool(cycleId, toolName, completion, completesRun = false) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            eventSource.removeListener(event_types.TOOL_CALLS_RENDERED, onToolsRendered);
            resolve(result);
        };
        const onToolsRendered = invocations => {
            if (invocations?.some(invocation => invocation.name === toolName) && (completesRun || getRun()?.cycleId === cycleId)) {
                finish(true);
            }
        };

        eventSource.on(event_types.TOOL_CALLS_RENDERED, onToolsRendered);
        completion.then(outcome => {
            if (!completesRun || outcome?.status !== 'complete') finish(false);
        });
    });
}

/**
 * Starts a continuation: opens the World Sim host chat and fires the selector. The run then
 * advances itself event-driven — the rendered `select_characters` call chains to the
 * updater, whose `world_update` call applies state and ends the run (see run-actions.js).
 * @returns {Promise<void>}
 */
export async function runCycle({ onSummaryProgress = null } = {}) {
    // A stale run is superseded rather than blocking; real concurrency is guarded by
    // openWorldCharacterChat() bailing while a generation is actually in flight.
    const state = getState();
    const roster = getRoster();

    const eligible = Object.values(roster.characters).filter(c => c.included && c.initialized);
    if (!eligible.length) return { status: 'blocked', reason: 'No eligible characters.' };

    if (!await openWorldCharacterChat()) return { status: 'blocked', reason: 'A generation is already in progress.' };

    const snapshot = captureCurrentWorldSnapshot();
    const baseRevisionId = getHeadRevisionId();
    const cycleId = generateCycleId();
    const completion = beginRun({ mode: 'continue', cycleId, characterIds: [], snapshot, baseSnapshot: snapshot, baseRevisionId, expectedHeadId: baseRevisionId, selectorResult: null });
    activateWorldSimToolScope([SELECT_CHARACTERS]);

    try {
        const selectorFinished = waitForWorldSimTool(cycleId, SELECT_CHARACTERS, completion);
        // Selector runs in its own chat. Its select_characters tool records the chosen ids
        // (run-actions.js) but does NOT chain the updater itself — doing so would create the
        // updater's fresh chat while ST is still executing the selector tool on this chat.
        await fireSelector({ snapshot });
        if (!await selectorFinished) return await completion;

        const run = getRun();
        if (!run || run.cycleId !== cycleId) return await completion;
        if (!run.characterIds.length) {
            if (failIfRunStillActive(cycleId, SELECT_CHARACTERS)) {
                pauseRun({ reason: `The model did not call ${SELECT_CHARACTERS}.` });
            }
            return await completion;
        }

        for (const id of run.characterIds) {
            await ensureCharacterCardContext(id, { onProgress: onSummaryProgress });
        }

        updateRun({ updaterStarted: true });
        activateWorldSimToolScope([WORLD_UPDATE]);
        const updaterFinished = waitForWorldSimTool(cycleId, WORLD_UPDATE, completion, true);
        await fireUpdater(run.characterIds, { snapshot });
        if (!await updaterFinished) return await completion;
        if (failIfRunStillActive(cycleId, WORLD_UPDATE)) {
            pauseRun({ reason: `The model did not call ${WORLD_UPDATE}.` });
        }
        return await completion;
    } catch (error) {
        if (wasGenerationStopped(error)) {
            console.warn(`World Sim cycle ${cycleId} interrupted; keeping tool scope active for retry.`, error);
            pauseRun({ status: 'cancelled', reason: 'Generation stopped.' });
            return await completion;
        }
        console.error('World Sim cycle failed:', error);
        clearWorldSimToolScope();
        endRun({ status: 'failed', reason: error?.message || String(error), error });
        return await completion;
    }
}

/**
 * Derives a stable, unique roster id from a character's avatar filename
 * (avatar filenames are unique in SillyTavern, unlike display names).
 * @param {string} avatar
 * @returns {string}
 */
export function avatarToId(avatar) {
    return String(avatar)
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'char';
}

/**
 * @param {string} avatar
 */
export function addCharacterToRoster(avatar) {
    const char = characters.find(c => c.avatar === avatar);
    if (!char) return;

    const roster = getRoster();
    if (Object.values(roster.characters).some(c => c.avatar === avatar)) return;

    let id = avatarToId(avatar);
    while (roster.characters[id]) id += '-2';

    roster.characters[id] = {
        id,
        name: char.name,
        avatar: char.avatar,
        included: false,
        priority: false,
        history: { location: [], activity: [], plan: [], summary: [] },
        initialized: false,
    };
}

/**
 * @param {string} id
 */
export function removeCharacterFromRoster(id) {
    const roster = getRoster();
    delete roster.characters[id];
    const state = getState();
    delete state.characters[id];
}

/**
 * @param {string} id
 */
export async function initializeCharacter(id) {
    const char = getRosterCharacter(id);
    if (!char) return;

    if (!await openWorldCharacterChat()) {
        toastr.error('Cannot initialize while a generation is in progress.', 'World Sim');
        return;
    }

    try {
        await ensureCharacterCardContext(id);
    } catch (error) {
        toastr.error(error?.message || String(error), 'World Sim Summary');
        return;
    }

    const cycleId = generateCycleId();
    const baseRevisionId = getHeadRevisionId();
    beginRun({ mode: 'initialize', cycleId, characterIds: [id], snapshot: captureCurrentWorldSnapshot(), baseSnapshot: captureCurrentWorldSnapshot(), baseRevisionId, expectedHeadId: baseRevisionId, selectorResult: null });
    activateWorldSimToolScope([WORLD_INITIALIZE]);

    try {
        await fireInitialize(char.avatar);
        failIfRunStillActive(cycleId, WORLD_INITIALIZE);
    } catch (error) {
        if (wasGenerationStopped(error)) {
            console.warn(`World Sim initialize ${cycleId} interrupted; keeping tool scope active for retry.`, error);
            return;
        }
        console.error('World Sim initialize failed:', error);
        clearWorldSimToolScope();
        endRun();
        toastr.error('Failed to initialize character.', 'World Sim');
    }
}

/**
 * Opens the roleplay scene that "zooms in" on a moment. Reuses ST's group-chat engine,
 * but the backing group is hidden from the main grid and tracked as a World Sim scene so
 * it lives in the Conversations tab. Reopens an existing scene for the same cycle.
 * @param {string[]} characterIds
 * @param {{ cycleId?: string|null, baseRevisionId?: string|null }} [context]
 * @returns {Promise<void>}
 */
export async function startRoleplayChat(characterIds, { cycleId = null, baseRevisionId = null } = {}) {
    if (isGenerationInProgress()) return;

    const { openGroupById, getGroups, groups } = await import('../group-chats.js');

    console.log('[world-sim] Open Scene requested for:', characterIds.join(', '), '| cycle:', cycleId);

    const existingScene = getSceneByCycle(cycleId);
    if (existingScene) {
        const group = groups.find(g => g.id === existingScene.groupId);
        if (group) {
            console.log('[world-sim] Reopening existing scene chat (keeping transcript), group:', group.id);
            if (await openGroupById(group.id)) setActiveGroup(group.id);
            return;
        }
        // Backing group is gone (deleted outside World Sim); drop the stale scene and recreate.
        removeScene(existingScene.sceneId);
    }

    const charAvatars = characterIds.map(id => getRosterCharacter(id)?.avatar).filter(Boolean);
    const charNames = characterIds.map(id => getRosterCharacter(id)?.name).filter(Boolean).join(', ');
    const resolvedBaseRevisionId = baseRevisionId || getHeadRevisionId();
    const sceneSnapshot = resolvedBaseRevisionId === getHeadRevisionId()
        ? captureCurrentWorldSnapshot()
        : await loadRevisionSnapshot(resolvedBaseRevisionId);

    // Create the group with its first chat already named (mirrors ST's createGroup), so opening
    // it via openGroupById selects the group and lets getGroupChat seed the fresh scene.
    const chatName = humanizedDateTime();
    const groupCreateModel = {
        name: `World Sim: ${charNames}`,
        members: charAvatars,
        avatar_url: 'img/favicon.ico',
        allow_self_responses: false,
        hideMutedSprites: false,
        activation_strategy: 0,
        generation_mode: 0,
        disabled_members: [],
        fav: false,
        chat_id: chatName,
        chats: [chatName],
        auto_mode_delay: 0,
    };

    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (!response.ok) {
        toastr.error('Failed to create roleplay group.', 'World Sim');
        return;
    }

    const data = await response.json();

    addScene({
        sceneId: data.id,
        groupId: data.id,
        cycleId,
        baseRevisionId: resolvedBaseRevisionId,
        characterIds: [...characterIds],
        title: charNames || 'Scene',
        createdAt: new Date().toISOString(),
        committed: false,
    });
    hiddenGroupIds.add(data.id);
    await saveWorldSimState();

    // Refresh the in-memory groups list so the new (hidden) group is present, then open it.
    // openGroupById selects the group (sets selected_group) and seeds the fresh chat — using
    // openGroupChat here would skip group selection and corrupt the chat's identity on save.
    console.log('[world-sim] Created new scene group:', data.id, '— opening it.');
    await getGroups();
    if (!await openGroupById(data.id, { openInWorkspace: false })) return;
    setActiveGroup(data.id);
    printCharacters();

    // Seed the freshly-created scene with current world context and auto-fire the opening turn.
    // (Reopened scenes keep their existing transcript — see the existingScene branch above.)
    await seedSceneOpening(characterIds, sceneSnapshot);
}

/**
 * Re-applies hidden-group state for all tracked scenes. Called on init so scene groups
 * stay out of the main grid across reloads.
 */
export function syncHiddenScenes() {
    for (const scene of getScenes()) {
        if (scene.groupId) hiddenGroupIds.add(scene.groupId);
    }
}

/**
 * Opens an existing scene by id.
 * @param {string} sceneId
 */
export async function openScene(sceneId) {
    const scene = getScene(sceneId);
    if (!scene) return;
    const { openGroupById, groups } = await import('../group-chats.js');
    const group = groups.find(g => g.id === scene.groupId);
    if (!group) {
        toastr.error('This scene\'s chat no longer exists.', 'World Sim');
        return;
    }
    if (await openGroupById(group.id)) setActiveGroup(group.id);
}

/**
 * Deletes a scene and its backing group chat.
 * @param {string} sceneId
 * @returns {Promise<void>}
 */
export async function deleteScene(sceneId) {
    const scene = getScene(sceneId);
    if (!scene) return;

    const response = await fetch('/api/groups/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: scene.groupId }),
    });
    if (!response.ok && response.status !== 404) {
        toastr.error('Failed to delete scene group.', 'World Sim');
        return;
    }

    hiddenGroupIds.delete(scene.groupId);
    removeScene(sceneId);
    await saveWorldSimState();

    const { getGroups } = await import('../group-chats.js');
    await getGroups();
    printCharacters();
}

/**
 * @param {string[]} characterIds
 * @param {string} chatMessages
 * @param {{cycleId?: string|null, baseRevisionId?: string|null}} [context]
 * @returns {Promise<object|false>} The completed run outcome, or false when it did not commit.
 */
export async function commitRoleplayToWorldState(characterIds, chatMessages, { cycleId = null, baseRevisionId = null } = {}) {
    if (!await openWorldCharacterChat()) {
        toastr.error('Cannot commit while a generation is in progress.', 'World Sim');
        return false;
    }

    // Reuse the scene's generation id when available so its tool run remains traceable.
    const resolvedCycleId = cycleId || generateCycleId();
    const expectedHeadId = getHeadRevisionId();
    const resolvedBaseRevisionId = baseRevisionId || expectedHeadId;
    const baseSnapshot = resolvedBaseRevisionId === expectedHeadId
        ? captureCurrentWorldSnapshot()
        : await loadRevisionSnapshot(resolvedBaseRevisionId);
    const completion = beginRun({ mode: 'commit', cycleId: resolvedCycleId, characterIds, snapshot: baseSnapshot, baseSnapshot, baseRevisionId: resolvedBaseRevisionId, expectedHeadId, selectorResult: null });
    activateWorldSimToolScope([WORLD_UPDATE]);

    try {
        const updateFinished = waitForWorldSimTool(resolvedCycleId, WORLD_UPDATE, completion, true);
        await fireCommit(characterIds, chatMessages, { snapshot: baseSnapshot });
        if (!await updateFinished) return false;
        if (failIfRunStillActive(resolvedCycleId, WORLD_UPDATE)) {
            return false;
        }
        const outcome = await completion;
        return outcome?.status === 'complete' ? outcome : false;
    } catch (error) {
        if (wasGenerationStopped(error)) {
            console.warn(`World Sim commit ${resolvedCycleId} interrupted; keeping tool scope active for retry.`, error);
            return false;
        }
        console.error('World Sim commit failed:', error);
        clearWorldSimToolScope();
        endRun();
        toastr.error('Failed to commit roleplay to world state.', 'World Sim');
        return false;
    }
}

/**
 * Loads a scene's roleplay transcript and commits it back to world state via the updater,
 * "collapsing" the zoomed-in scene into character string updates.
 * @param {string} sceneId
 * @returns {Promise<void>}
 */
export async function commitScene(sceneId) {
    const scene = getScene(sceneId);
    if (!scene) return;

    const { groups } = await import('../group-chats.js');
    const group = groups.find(g => g.id === scene.groupId);
    if (!group) {
        toastr.error('This scene\'s chat no longer exists.', 'World Sim');
        return;
    }

    const transcript = await loadSceneTranscript(group.chat_id);
    if (!transcript) {
        toastr.warning('This scene has no messages to commit yet.', 'World Sim');
        return;
    }

    const outcome = await commitRoleplayToWorldState(scene.characterIds, transcript, {
        cycleId: scene.cycleId,
        baseRevisionId: scene.baseRevisionId,
    });
    if (outcome) {
        const committedCharacterIds = [...new Set([...(scene.characterIds || []), ...(outcome.characterIds || [])])];
        const committedNames = committedCharacterIds.map(id => getRosterCharacter(id)?.name).filter(Boolean).join(', ');
        updateScene(sceneId, {
            committed: true,
            characterIds: committedCharacterIds,
            title: committedNames || scene.title,
        });
        await saveWorldSimState();
    }
}

/**
 * Fetches a group chat file and renders it as a plain "Name: message" transcript,
 * skipping the metadata header and system messages.
 * @param {string} chatId
 * @returns {Promise<string>} The transcript, or empty string if there are no messages.
 */
async function loadSceneTranscript(chatId) {
    const response = await fetch('/api/chats/group/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId }),
    });
    if (!response.ok) return '';

    const data = await response.json();
    if (!Array.isArray(data)) return '';

    const lines = data
        .filter(m => m && typeof m.mes === 'string' && m.mes.trim() && !m.is_system)
        .map(m => `${m.name || (m.is_user ? 'User' : 'Unknown')}: ${m.mes.trim()}`);

    return lines.join('\n\n');
}

/**
 * Runs one guided event from the current head or a historical revision.
 * Guidance directs the action itself; character constraints only shape who takes part.
 * @param {{guidance:string, baseRevisionId?:string|null, includedCharacterIds?:string[], excludedCharacterIds?:string[], exactCharacterSelection?:boolean}} request
 */
export async function runGuidedCycle(request = {}) {
    const direction = String(request.guidance || '').trim();
    if (!direction) return { status: 'blocked', reason: 'Action guidance is required.' };

    const expectedHeadId = getHeadRevisionId();
    const baseRevisionId = request.baseRevisionId || expectedHeadId;
    const baseSnapshot = baseRevisionId === expectedHeadId
        ? captureCurrentWorldSnapshot()
        : await loadRevisionSnapshot(baseRevisionId);
    const roster = getRoster();
    const eligible = id => roster.characters[id]?.included
        && (baseSnapshot?.characters?.[id]?.initialized ?? roster.characters[id]?.initialized);
    const excludedCharacterIds = [...new Set((request.excludedCharacterIds || []).map(String))]
        .filter(eligible)
        .slice(0, 10);
    const excluded = new Set(excludedCharacterIds);
    const includedCharacterIds = [...new Set((request.includedCharacterIds || []).map(String))]
        .filter(id => eligible(id) && !excluded.has(id))
        .slice(0, 10);
    const exactCharacterSelection = !!request.exactCharacterSelection;
    if (exactCharacterSelection && !includedCharacterIds.length) {
        return { status: 'blocked', reason: 'Choose at least one required character for an exact guided run.' };
    }
    if (!await openWorldCharacterChat()) return { status: 'blocked', reason: 'A generation is already in progress.' };

    const cycleId = generateCycleId();
    const completion = beginRun({
        mode: baseRevisionId === expectedHeadId ? 'guided' : 'branch',
        cycleId,
        characterIds: exactCharacterSelection ? includedCharacterIds : [],
        selectorResult: exactCharacterSelection ? { characterIds: includedCharacterIds } : null,
        snapshot: baseSnapshot,
        baseSnapshot,
        baseRevisionId,
        expectedHeadId,
        guidance: direction,
        includedCharacterIds,
        excludedCharacterIds,
        exactCharacterSelection,
    });
    try {
        if (!exactCharacterSelection) {
            activateWorldSimToolScope([SELECT_CHARACTERS]);
            const selectorFinished = waitForWorldSimTool(cycleId, SELECT_CHARACTERS, completion);
            await fireSelector({
                snapshot: baseSnapshot,
                guidance: direction,
                selection: { includedCharacterIds, excludedCharacterIds },
            });
            if (!await selectorFinished) return await completion;
        }

        let run = getRun();
        if (!run || run.cycleId !== cycleId) return await completion;
        if (!run.characterIds.length) {
            if (failIfRunStillActive(cycleId, SELECT_CHARACTERS)) pauseRun({ reason: `The model did not call ${SELECT_CHARACTERS}.` });
            return await completion;
        }
        for (const id of run.characterIds) await ensureCharacterCardContext(id);
        updateRun({ updaterStarted: true });
        activateWorldSimToolScope([WORLD_UPDATE]);
        const updaterFinished = waitForWorldSimTool(cycleId, WORLD_UPDATE, completion, true);
        await fireUpdater(run.characterIds, { snapshot: baseSnapshot, guidance: direction });
        if (!await updaterFinished) return await completion;
        if (failIfRunStillActive(cycleId, WORLD_UPDATE)) pauseRun({ reason: `The model did not call ${WORLD_UPDATE}.` });
        return await completion;
    } catch (error) {
        if (wasGenerationStopped(error)) {
            pauseRun({ status: 'cancelled', reason: 'Generation stopped.' });
            return await completion;
        }
        console.error('World Sim guided run failed:', error);
        clearWorldSimToolScope();
        endRun({ status: 'failed', reason: error?.message || String(error), error });
        return await completion;
    }
}

export async function branchFromRevision(revisionId, guidance, selection = {}) {
    return runGuidedCycle({ ...selection, baseRevisionId: revisionId, guidance });
}
