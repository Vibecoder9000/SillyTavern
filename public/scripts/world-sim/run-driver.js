// Drives a World Sim run through its visible stages and lets the user steer it:
// retry a step, approve the selection, abort, jump to the chat, go back to the previous
// chat. Entry points (`runCycle` etc.) live in main.js and hand a begun run to the
// drivers here. See run-context.js for the stage model.

import { characters, chat, eventSource, event_types, getCurrentChatId, openCharacterChat, selectCharacterById, this_chid } from '../../script.js';
import { getConfig } from './state.js';
import { fireSelector, fireUpdater, fireInitialize, fireCommit } from './llm.js';
import { activateWorldSimToolScope, clearWorldSimToolScope, SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE } from './tools.js';
import { isGenerationInProgress, openWorldCharacterChat, WORLD_CHARACTER_AVATAR } from './world-character.js';
import { approveSelection, endRun, getRun, pauseRun, rearmRun, setRunResumer, setRunStage, updateRun, waitForSelectionReview } from './run-context.js';
import { ensureCharacterCardContext } from './card-summary.js';

const TOOL_GRACE_MS = 1500;

/**
 * World Sim should keep the scoped tool available when the generation was merely stopped
 * before the tool executed. That lets the user retry/correct the same request.
 * @param {unknown} error
 * @returns {boolean}
 */
export function wasGenerationStopped(error) {
    const message = String(error?.message || error || '');
    return error?.name === 'AbortError' || /\babort(?:ed|ing)?\b|\bstopp?(?:ed|ing)?\b/i.test(message);
}

/** Waits for a tool result, or for another action to supersede this run. */
export function waitForWorldSimTool(cycleId, toolName, completion, completesRun = false) {
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

/** Whether the latest host-chat messages hold a rendered-but-not-yet-executed call to `toolName`. */
function hasPendingToolCall(toolName) {
    for (const message of chat.slice(-3)) {
        const segments = Array.isArray(message?.extra?.native_tool_segments) ? message.extra.native_tool_segments : [];
        if (segments.some(segment => segment?.type === 'tool' && segment.tool_call?.tool === toolName)) return true;
        if (message?.extra?.tool_call_info?.tool === toolName) return true;
    }
    return false;
}

/**
 * Called once a generation has finished. Resolves true when the expected tool ran.
 * If the call is waiting for a click the run shows `waiting-for-user` and keeps waiting;
 * if the model never called the tool the run is paused as `stalled`.
 * @returns {Promise<boolean>}
 */
async function settleTool(toolName, toolPromise) {
    const early = await Promise.race([toolPromise, new Promise(resolve => setTimeout(() => resolve('timeout'), TOOL_GRACE_MS))]);
    if (early !== 'timeout') return early;
    if (!getRun()) return false;
    if (hasPendingToolCall(toolName)) {
        setRunStage('waiting-for-user', toolName);
        return await toolPromise;
    }
    pauseRun({ stage: 'stalled', reason: `The model answered without calling ${toolName}.` });
    return false;
}

function pauseAfterStop(error = null) {
    const reason = error?.name === 'AbortError' && error.message ? error.message : 'Generation stopped.';
    pauseRun({ status: 'cancelled', stage: 'stopped', reason });
}

function pauseAfterError(error) {
    console.error('World Sim run failed:', error);
    pauseRun({ status: 'failed', stage: 'failed', reason: error?.message || String(error), error });
}

/**
 * Drives selector -> (review) -> prepare -> updater for an event run.
 * @param {string} cycleId
 * @param {Promise<object>} completion
 * @param {'select'|'review'|'prepare'|'update'} step  Where to start (Retry re-enters mid-way).
 * @returns {Promise<object>}
 */
export async function driveEvent(cycleId, completion, step = 'select') {
    const live = () => {
        const run = getRun();
        return run && run.cycleId === cycleId ? run : null;
    };
    try {
        let run = live();
        if (!run) return await completion;
        const { snapshot = null, guidance = '', selection = null, onSummaryProgress = null } = run.driver || {};

        if (step === 'select') {
            setRunStage('selecting');
            activateWorldSimToolScope([SELECT_CHARACTERS]);
            const finished = waitForWorldSimTool(cycleId, SELECT_CHARACTERS, completion);
            // Selector runs in its own chat. Its select_characters tool records the chosen ids
            // (run-actions.js) but does NOT chain the updater itself — doing so would create the
            // updater's fresh chat while ST is still executing the selector tool on this chat.
            await fireSelector({ snapshot, guidance, selection });
            if (!await settleTool(SELECT_CHARACTERS, finished)) return await completion;
            run = live();
            if (!run) return await completion;
            if (!run.characterIds.length) {
                pauseRun({ stage: 'stalled', reason: 'No characters were selected.' });
                return await completion;
            }
            step = 'review';
        }

        if (step === 'review') {
            run = live();
            if (!run) return await completion;
            if (getConfig().reviewSelection !== false && !run.exactCharacterSelection) {
                setRunStage('selection-ready');
                if (!await waitForSelectionReview()) return await completion;
                run = live();
                if (!run) return await completion;
                if (!run.characterIds.length) {
                    clearWorldSimToolScope();
                    endRun({ status: 'blocked', reason: 'No characters were left to update.' });
                    return await completion;
                }
            }
            step = 'prepare';
        }

        if (step === 'prepare') {
            run = live();
            if (!run) return await completion;
            setRunStage('preparing-context');
            for (const id of run.characterIds) await ensureCharacterCardContext(id, { onProgress: onSummaryProgress });
            step = 'update';
        }

        run = live();
        if (!run) return await completion;
        updateRun({ updaterStarted: true });
        setRunStage('updating');
        activateWorldSimToolScope([WORLD_UPDATE]);
        const updaterFinished = waitForWorldSimTool(cycleId, WORLD_UPDATE, completion, true);
        await fireUpdater(run.characterIds, { snapshot, guidance });
        if (!await settleTool(WORLD_UPDATE, updaterFinished)) return await completion;
        if (live()) {
            pauseRun({ stage: 'failed', reason: `${WORLD_UPDATE} did not complete. Check the tool result in chat, then retry.` });
        }
        return await completion;
    } catch (error) {
        if (wasGenerationStopped(error)) pauseAfterStop(error);
        else pauseAfterError(error);
        return await completion;
    }
}

/** Drives the single-character initialize generation. Does not block the caller. */
export async function driveInitialize(cycleId, completion) {
    try {
        const run = getRun();
        if (!run || run.cycleId !== cycleId) return;
        const avatar = run.driver?.avatar;
        setRunStage('updating', 'initialize');
        activateWorldSimToolScope([WORLD_INITIALIZE]);
        const finished = waitForWorldSimTool(cycleId, WORLD_INITIALIZE, completion, true);
        await fireInitialize(avatar);
        void settleTool(WORLD_INITIALIZE, finished);
    } catch (error) {
        if (wasGenerationStopped(error)) pauseAfterStop(error);
        else {
            console.error('World Sim initialize failed:', error);
            clearWorldSimToolScope();
            endRun({ status: 'failed', reason: error?.message || String(error), error });
            toastr.error('Failed to initialize character.', 'World Sim');
        }
    }
}

/**
 * Drives the scene-commit generation.
 * @returns {Promise<object|false>} The completed outcome, or false when it did not commit.
 */
export async function driveCommit(cycleId, completion) {
    try {
        const run = getRun();
        if (!run || run.cycleId !== cycleId) return false;
        const { chatMessages = '', snapshot = null } = run.driver || {};
        setRunStage('updating');
        activateWorldSimToolScope([WORLD_UPDATE]);
        const finished = waitForWorldSimTool(cycleId, WORLD_UPDATE, completion, true);
        await fireCommit(run.characterIds, chatMessages, { snapshot });
        if (!await settleTool(WORLD_UPDATE, finished)) {
            const outcome = await completion;
            return outcome?.status === 'complete' ? outcome : false;
        }
        if (getRun()?.cycleId === cycleId) {
            pauseRun({ stage: 'failed', reason: `${WORLD_UPDATE} did not complete. Check the tool result in chat, then retry.` });
            return false;
        }
        const outcome = await completion;
        return outcome?.status === 'complete' ? outcome : false;
    } catch (error) {
        if (wasGenerationStopped(error)) pauseAfterStop(error);
        else {
            toastr.error('Failed to commit roleplay to world state.', 'World Sim');
            pauseAfterError(error);
        }
        return false;
    }
}

/** Callbacks main.js registers so retry can finish a scene commit it did not start. */
let onRetriedRunComplete = null;
export function setRetriedRunHandler(fn) {
    onRetriedRunComplete = fn;
}

function finishRetried(promise, run) {
    void promise.then(outcome => {
        if (outcome && outcome.status === 'complete') onRetriedRunComplete?.(run, outcome);
    });
}

/**
 * Retry step: regenerates the step the run stalled/stopped/failed at.
 * @returns {Promise<boolean>} Whether a retry was started.
 */
export async function retryRun() {
    const run = getRun();
    if (!run || !run.detached) return false;
    if (isGenerationInProgress()) {
        toastr.warning('Wait for the current generation to finish, or stop it first.', 'World Sim');
        return false;
    }
    if (!await openWorldCharacterChat()) return false;
    const stageBefore = run.resumeStage || run.stage;
    const completion = rearmRun();
    if (!completion) return false;
    const cycleId = run.cycleId;
    if (run.mode === 'initialize') {
        void driveInitialize(cycleId, completion);
    } else if (run.mode === 'commit') {
        finishRetried(driveCommit(cycleId, completion), run);
    } else {
        const step = !run.characterIds?.length || stageBefore === 'selecting'
            ? 'select'
            : stageBefore === 'selection-ready'
                ? 'review'
                : stageBefore === 'preparing-context' ? 'prepare' : 'update';
        finishRetried(driveEvent(cycleId, completion, step), run);
    }
    return true;
}

/** Abort run: drops the tool scope and ends the run as cancelled. */
export function abortRun() {
    clearWorldSimToolScope();
    endRun({ status: 'cancelled', reason: 'Run aborted.' });
}

/** User approved the (possibly edited) selection: continue to the updater. */
export function confirmSelection() {
    approveSelection();
}

/**
 * The user executed the scoped tool from chat after the driver had paused (a manual retry
 * in chat); pick the run back up from where that tool leaves it.
 */
setRunResumer(run => {
    if (run.mode === 'initialize' || run.mode === 'commit') return;
    if (!run.characterIds?.length) return;
    const completion = rearmRun();
    if (completion) finishRetried(driveEvent(run.cycleId, completion, 'review'), run);
});

// ---- Navigating the host chat ----

let returnTarget = null;

function isHostChatOpen() {
    return characters[this_chid]?.avatar === WORLD_CHARACTER_AVATAR;
}

/** Remembers the user's chat before a run switches to the host chat. Never overwritten while in the host chat. */
export async function rememberReturnTarget() {
    if (isHostChatOpen()) return;
    const { selected_group, groups } = await import('../group-chats.js');
    if (selected_group) {
        returnTarget = { groupId: selected_group, chatId: getCurrentChatId(), name: groups.find(g => g.id === selected_group)?.name || 'group chat' };
    } else if (this_chid !== undefined && characters[this_chid]) {
        returnTarget = { avatar: characters[this_chid].avatar, chatId: getCurrentChatId(), name: characters[this_chid].name };
    } else {
        returnTarget = null;
    }
}

export function getReturnTarget() {
    return returnTarget && !isHostChatOpen() ? null : returnTarget;
}

export async function goBackToPreviousChat() {
    const target = returnTarget;
    if (!target) return;
    if (isGenerationInProgress()) {
        toastr.warning('Wait for the current generation to finish first.', 'World Sim');
        return;
    }
    returnTarget = null;
    try {
        if (target.groupId) {
            const { openGroupById, openGroupChat } = await import('../group-chats.js');
            if (await openGroupById(target.groupId) && target.chatId) await openGroupChat(target.groupId, target.chatId);
        } else {
            const index = characters.findIndex(character => character.avatar === target.avatar);
            if (index < 0) return;
            await selectCharacterById(index);
            if (target.chatId && target.chatId !== getCurrentChatId()) await openCharacterChat(target.chatId);
        }
    } catch (error) {
        console.error('World Sim: could not return to the previous chat', error);
        toastr.error('Could not return to the previous chat.', 'World Sim');
    }
}

/** Opens the host chat if needed and scrolls to its newest message (the step's tool call). */
export async function showRunInChat() {
    if (!isHostChatOpen() && !await openWorldCharacterChat()) {
        toastr.warning('Wait for the current generation to finish first.', 'World Sim');
        return;
    }
    const last = [...document.querySelectorAll('#chat .mes')].at(-1);
    last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
