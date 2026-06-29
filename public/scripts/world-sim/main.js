import {
    getRoster,
    getState,
    updateState,
    saveWorldSimState,
    getRosterCharacter,
    loadSnapshot,
    getScenes,
    getScene,
    getSceneByCycle,
    addScene,
    updateScene,
    removeScene,
} from './state.js';
import { characters, getRequestHeaders, hiddenGroupIds, printCharacters, setActiveGroup } from '../../script.js';
import { humanizedDateTime } from '../RossAscends-mods.js';
import { fireSelector, fireUpdater, fireInitialize, fireCommit, seedSceneOpening } from './llm.js';
import { activateWorldSimToolScope, clearWorldSimToolScope, SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE } from './tools.js';
import { openWorldCharacterChat } from './world-character.js';
import { beginRun, getRun, endRun, generateCycleId } from './run-context.js';
import { stopTimer } from './timer.js';
import { updateWorldClock } from './ui.js';

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

/**
 * Starts a tick: opens the World Sim host chat and fires the selector. The run then
 * advances itself event-driven — the rendered `select_characters` call chains to the
 * updater, whose `world_update` call applies state and ends the run (see run-actions.js).
 * @returns {Promise<void>}
 */
export async function runCycle({ ignorePaused = false } = {}) {
    // A stale run is superseded rather than blocking; real concurrency is guarded by
    // openWorldCharacterChat() bailing while a generation is actually in flight.
    const state = getState();
    const roster = getRoster();

    if (!ignorePaused && (state.paused || state.idlePaused)) return;

    const eligible = Object.values(roster.characters).filter(c => c.included && c.initialized);
    if (!eligible.length) return;

    if (!await openWorldCharacterChat()) return;

    const snapshot = {
        tick: state.tick,
        inWorldMinutes: state.inWorldMinutes,
        characters: JSON.parse(JSON.stringify(state.characters)),
    };
    const cycleId = generateCycleId();
    beginRun({ mode: 'tick', cycleId, characterIds: [], snapshot, selectorResult: null });
    activateWorldSimToolScope([SELECT_CHARACTERS]);

    try {
        // Selector runs in its own chat. Its select_characters tool records the chosen ids
        // (run-actions.js) but does NOT chain the updater itself — doing so would create the
        // updater's fresh chat while ST is still executing the selector tool on this chat.
        await fireSelector();

        const run = getRun();
        if (!run || run.cycleId !== cycleId) return; // selector bailed (no characters)
        if (!run.characterIds.length) {
            failIfRunStillActive(cycleId, SELECT_CHARACTERS);
            // Signal that if the user retries the selector, onSelectCharacters must chain
            // directly to the updater (runCycle has already returned past the chaining point).
            updateRun({ needsUpdaterChain: true });
            return;
        }

        // Now safe: the selector chat is fully resolved. Fire the updater in its own fresh
        // chat so it doesn't pay to re-read the selector exchange.
        activateWorldSimToolScope([WORLD_UPDATE]);
        await fireUpdater(run.characterIds);
        failIfRunStillActive(cycleId, WORLD_UPDATE);
    } catch (error) {
        console.error('World Sim cycle failed:', error);
        clearWorldSimToolScope();
        endRun();
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
        strings: { location: '', activity: '', plan: '', summary: '' },
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

    const cycleId = generateCycleId();
    beginRun({ mode: 'initialize', cycleId, characterIds: [id], snapshot: null, selectorResult: null });
    activateWorldSimToolScope([WORLD_INITIALIZE]);

    try {
        await fireInitialize(char.avatar);
        failIfRunStillActive(cycleId, WORLD_INITIALIZE);
    } catch (error) {
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
 * @param {{ cycleId?: string|null, tick?: number|null }} [context]
 * @returns {Promise<void>}
 */
export async function startRoleplayChat(characterIds, { cycleId = null, tick = null } = {}) {
    const { openGroupById, getGroups, groups } = await import('../group-chats.js');

    console.log('[world-sim] Open Scene requested for:', characterIds.join(', '), '| cycle:', cycleId);

    const existingScene = getSceneByCycle(cycleId);
    if (existingScene) {
        const group = groups.find(g => g.id === existingScene.groupId);
        if (group) {
            console.log('[world-sim] Reopening existing scene chat (keeping transcript), group:', group.id);
            setActiveGroup(group.id);
            await openGroupById(group.id);
            return;
        }
        // Backing group is gone (deleted outside World Sim); drop the stale scene and recreate.
        removeScene(existingScene.sceneId);
    }

    const charAvatars = characterIds.map(id => getRosterCharacter(id)?.avatar).filter(Boolean);
    const charNames = characterIds.map(id => getRosterCharacter(id)?.name).filter(Boolean).join(', ');

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
        tick,
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
    setActiveGroup(data.id);
    await openGroupById(data.id);
    printCharacters();

    // Seed the freshly-created scene with the focused event's world context and auto-fire the
    // opening turn. `tick` anchors the opening to the event being zoomed into, not latest state.
    // (Reopened scenes keep their existing transcript — see the existingScene branch above.)
    await seedSceneOpening(characterIds, tick);
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
    setActiveGroup(group.id);
    await openGroupById(group.id);
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
 * @returns {Promise<boolean>} Whether the commit run started successfully.
 */
export async function commitRoleplayToWorldState(characterIds, chatMessages, { cycleId = null, tick = null } = {}) {
    if (!await openWorldCharacterChat()) {
        toastr.error('Cannot commit while a generation is in progress.', 'World Sim');
        return false;
    }

    // Reuse the zoomed event's cycleId so the committed result supersedes it on load
    // (loadCycles keeps the last line per cycleId). New scenes without one get a fresh id.
    const resolvedCycleId = cycleId || generateCycleId();
    beginRun({ mode: 'commit', cycleId: resolvedCycleId, tick, characterIds, snapshot: null, selectorResult: null });
    activateWorldSimToolScope([WORLD_UPDATE]);

    try {
        await fireCommit(characterIds, chatMessages);
        if (failIfRunStillActive(resolvedCycleId, WORLD_UPDATE)) {
            return false;
        }
        return true;
    } catch (error) {
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

    const ok = await commitRoleplayToWorldState(scene.characterIds, transcript, {
        cycleId: scene.cycleId,
        tick: scene.tick,
    });
    if (ok) {
        updateScene(sceneId, { committed: true });
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
 * Restores world state to the snapshot captured before the given cycle's updater ran.
 * @param {string} cycleId
 * @returns {Promise<boolean>}
 */
export async function revertCycle(cycleId) {
    const snapshot = await loadSnapshot(cycleId);
    if (!snapshot || !snapshot.characters) {
        toastr.error('No snapshot available for this tick.', 'World Sim');
        return false;
    }

    const state = getState();
    updateState({
        tick: snapshot.tick ?? state.tick,
        inWorldMinutes: snapshot.inWorldMinutes ?? state.inWorldMinutes,
    });
    state.characters = JSON.parse(JSON.stringify(snapshot.characters));

    await saveWorldSimState();
    updateWorldClock();
    return true;
}

// Stop auto-generation on page unload
window.addEventListener('beforeunload', () => {
    stopTimer();
});
