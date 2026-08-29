import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const appScript = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const bridgeScript = readFileSync(new URL('../public/scripts/chat-workspace-bridge.js', import.meta.url), 'utf8');
const shellScript = readFileSync(new URL('../public/scripts/chat-workspace.js', import.meta.url), 'utf8');
const eventEmitterScript = readFileSync(new URL('../public/lib/eventemitter.js', import.meta.url), 'utf8');
const groupScript = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
const promptScript = readFileSync(new URL('../public/scripts/itemized-prompts.js', import.meta.url), 'utf8');
const personaScript = readFileSync(new URL('../public/scripts/personas.js', import.meta.url), 'utf8');
const authorsNoteScript = readFileSync(new URL('../public/scripts/authors-note.js', import.meta.url), 'utf8');
const workspaceCacheScript = readFileSync(new URL('../public/scripts/chat-workspace-cache.js', import.meta.url), 'utf8');
const toolCallingScript = readFileSync(new URL('../public/scripts/tool-calling.js', import.meta.url), 'utf8');

describe('chat workspace activation fast path', () => {
    test('clears once and defers character and group selection persistence', () => {
        const openIdentity = appScript.slice(
            appScript.indexOf('async function openWorkspaceIdentity'),
            appScript.indexOf('function restoreWorkspaceView'),
        );
        expect(openIdentity).toContain('skipClear: selectionClearedChat');
        expect(openIdentity.match(/persistSelection: false/g)).toHaveLength(2);

        const characterOpen = appScript.slice(
            appScript.indexOf('export async function openCharacterChat'),
            appScript.indexOf('////////// OPTIMZED MAIN API CHANGE FUNCTION'),
        );
        expect(characterOpen).toContain('persistSelection = true');
        expect(characterOpen).toContain("runMeasuredStage(measureStage, 'chatClear', () => clearChat({ clearData: true }))");
        expect(characterOpen).toContain("if (persistSelection) await createOrEditCharacter(new CustomEvent('newChat'))");

        const groupOpen = groupScript.slice(
            groupScript.indexOf('export async function openGroupChat'),
            groupScript.indexOf('/**\n * Renames a group or character chat'),
        );
        expect(groupOpen).toContain('persistSelection = true');
        expect(groupOpen).toContain("runMeasuredStage(measureStage, 'chatClear', () => clearChat({ clearData: true }))");
        expect(groupOpen).toContain('if (persistSelection) await editGroup(groupId, true, false)');
    });

    test('starts captured persistence only after the shell confirms the commit', () => {
        const navigate = bridgeScript.slice(
            bridgeScript.indexOf('async function navigate'),
            bridgeScript.indexOf('export function initChatWorkspaceBridge'),
        );
        expect(navigate).toContain("post('prepared'");
        expect(navigate).not.toContain('onCommitted');

        const activeHandler = bridgeScript.slice(
            bridgeScript.indexOf("if (message.type === 'active')"),
            bridgeScript.indexOf("if (message.type === 'persona-state')"),
        );
        expect(activeHandler.indexOf('finishNavigationTiming')).toBeLessThan(activeHandler.indexOf('bridgeApi.onCommitted'));
        expect(activeHandler).toContain('void runInBackground(() => bridgeApi.onCommitted?.(assignedIdentity)');
        expect(activeHandler).not.toContain('await bridgeApi.onCommitted');
    });

    test('flushes the background mirror before capturing a new-chat snapshot', () => {
        const prepare = appScript.slice(
            appScript.indexOf('export async function prepareWorkspaceLastChatForNewChat'),
            appScript.indexOf('function applyWorkspaceLastChatPrompt'),
        );
        expect(prepare.indexOf('await workspaceMirrorWriter.flush()')).toBeLessThan(prepare.indexOf('await captureWorkspaceLastChat(workspace)'));
    });

    test('logs content-free timing stages for successful and failed switches', () => {
        const finishTiming = bridgeScript.slice(
            bridgeScript.indexOf('function finishNavigationTiming'),
            bridgeScript.indexOf('function queueWorkspaceNavigation'),
        );
        expect(finishTiming).toContain("console.info('[Chat workspace] Tab switch timing'");
        expect(finishTiming).toContain('stagesMs');
        expect(finishTiming).toContain('totalMs');
        expect(finishTiming).not.toMatch(/message|identity|character|chatId/i);
        expect(bridgeScript).toContain("finishNavigationTiming('success')");
        expect(bridgeScript).toContain("finishNavigationTiming('error')");
        expect(bridgeScript).toContain("finishNavigationTiming('blocked')");
    });

    test('breaks identity loading into fetch, parse, render, UI, and event stages', () => {
        const characterLoad = appScript.slice(
            appScript.indexOf('export async function getChat'),
            appScript.indexOf('function getFirstMessage'),
        );
        for (const stage of ['characterLoad', 'chatFetch', 'chatParse', 'chatApply', 'itemizedPrompts', 'messageRender', 'ownerUi', 'chatEvents']) {
            expect(characterLoad).toContain(`'${stage}'`);
        }
        expect(bridgeScript).toContain('bridgeApi.openIdentity(identity, measureNavigationStage)');
        expect(bridgeScript).not.toContain("measureNavigationStage('identityLoad'");
    });

    test('avoids duplicate owner and persona UI work during workspace activation', () => {
        const openIdentity = appScript.slice(
            appScript.indexOf('async function openWorkspaceIdentity'),
            appScript.indexOf('function restoreWorkspaceView'),
        );
        expect(openIdentity).toContain('refreshOwnerUi: false');
        expect(openIdentity).toContain('await withoutAutoPersonaSelection(openIdentity)');
        expect(openIdentity).not.toContain('if (canPersistWorkspaceGlobals()) await openIdentity()');

        const selectCharacter = appScript.slice(
            appScript.indexOf('export async function selectCharacterById'),
            appScript.indexOf('export function getCharacters'),
        );
        expect(selectCharacter).toContain('refreshOwnerUi = true');
        expect(selectCharacter).toContain('} else if (refreshOwnerUi) {');
    });

    test('reads prompt data ahead and caches repeat workspace visits', () => {
        const getChat = appScript.slice(
            appScript.indexOf('export async function getChat'),
            appScript.indexOf('function getFirstMessage'),
        );
        expect(getChat).toContain('prepareItemizedPrompts(getCurrentChatId())');
        expect(getChat).toContain('preparedItemizedPrompts, refreshOwnerUi');
        expect(groupScript).toContain('prepareItemizedPrompts(group.chat_id)');
        expect(promptScript).toContain('const MAX_CACHED_PROMPT_CHATS = 8');
        expect(promptScript).toContain('pendingItemizedPromptLoads');
        expect(appScript).toContain('unloadItemizedPrompts();');
        expect(appScript).not.toContain('itemizedPrompts.length = 0;');
    });

    test('reuses the loaded avatar inventory for non-rendering persona checks', () => {
        const getUserAvatars = personaScript.slice(
            personaScript.indexOf('export async function getUserAvatars'),
            personaScript.indexOf('async function uploadUserAvatar'),
        );
        expect(getUserAvatars).toContain('Date.now() - cachedUserAvatarsAt < USER_AVATAR_CACHE_TTL');
        expect(getUserAvatars).toContain('cachedUserAvatars = allEntities');

        const syncUserAvatar = personaScript.slice(
            personaScript.indexOf('export async function syncUserAvatar'),
            personaScript.indexOf('function reloadUserAvatar'),
        );
        expect(syncUserAvatar).not.toContain('updatePersonaUIStates();');
    });

    test('counts independent author-note sections concurrently without blocking chat change', () => {
        const onChatChanged = authorsNoteScript.slice(
            authorsNoteScript.indexOf('function onChatChanged'),
            authorsNoteScript.indexOf('function onAllowWIScanCheckboxChanged'),
        );
        expect(onChatChanged).toContain('void updateTokenCounters');
        expect(onChatChanged).toContain('await Promise.all([');
        expect(onChatChanged).toContain('revision !== tokenCounterUpdateRevision');
    });

    test('rebuilds a changed character editor only after the chat commit', () => {
        const openIdentity = appScript.slice(
            appScript.indexOf('async function openWorkspaceIdentity'),
            appScript.indexOf('function restoreWorkspaceView'),
        );
        expect(openIdentity).toContain('refreshOwnerUi: false');
        expect(openIdentity).toContain('pendingWorkspaceOwnerUiIdentity = { ...identity }');
        const postCommit = appScript.slice(
            appScript.indexOf('async function persistWorkspacePostCommit'),
            appScript.indexOf('async function openWorkspaceIdentity'),
        );
        expect(postCommit).toContain('await delay(0)');
        expect(postCommit).toContain("restoredDraftInput?.dispatchEvent(new Event('input', { bubbles: true }))");
        expect(postCommit).toContain('select_selected_character(characterId, { switchMenu: false })');
        expect(postCommit).toContain('select_group_chats(identity.ownerId, true)');
        expect(openIdentity).toContain('openGroupById(group.id, { openInWorkspace: false, loadChat: false, refreshOwnerUi: false, measureStage })');
        expect(groupScript).toContain('refreshOwnerUi = true');
        expect(groupScript).toContain('if (refreshOwnerUi) await runMeasuredStage');
        expect(appScript).toContain("$('#selected_chat_pole').val(characters[this_chid].chat)");

        const restoreView = appScript.slice(
            appScript.indexOf('function restoreWorkspaceView'),
            appScript.indexOf('function initInAppChatWorkspace'),
        );
        expect(restoreView).toContain('pendingWorkspaceDraftInput = textarea');
        expect(restoreView).not.toContain("dispatchEvent(new Event('input'");
    });

    test('keeps bounded cloned chat snapshots for warm character and group switches', () => {
        expect(workspaceCacheScript).toContain('const MAX_CACHED_CHATS = 12');
        expect(workspaceCacheScript).toContain('export function getWorkspaceChatSnapshot');
        expect(workspaceCacheScript).toContain('export function setWorkspaceChatSnapshot');
        expect(workspaceCacheScript).toContain('return cloneValue(snapshot)');
        expect(appScript).toContain("runMeasuredStage(measureStage, 'chatCache'");
        expect(appScript).toContain('setWorkspaceChatSnapshot(getWorkspaceChatIdentity(), chat_metadata, chat)');
        expect(groupScript).toContain("kind: 'group'");
        expect(groupScript).toContain("runMeasuredStage(measureStage, 'chatCache'");
    });

    test('reuses the sandbox workspace inventory during chat event processing', () => {
        expect(toolCallingScript).toContain('const SANDBOX_WORKSPACES_CACHE_TTL = 60_000');
        expect(toolCallingScript).toContain('pendingSandboxWorkspacesFetch');
        expect(toolCallingScript).toContain('fetchSandboxWorkspaces({ forceRefresh })');
        expect(toolCallingScript).toContain('refreshSandboxWorkspaceSelector({ forceRefresh: true })');
    });

    test('commits warm workspace loads before asynchronous chat observers finish', () => {
        const openIdentity = appScript.slice(
            appScript.indexOf('async function openWorkspaceIdentity'),
            appScript.indexOf('function restoreWorkspaceView'),
        );
        const flushPending = appScript.slice(
            appScript.indexOf('async function flushWorkspacePendingChat'),
            appScript.indexOf('async function resumeWorkspaceGeneration'),
        );
        expect(eventEmitterScript).toContain('EventEmitter.prototype.emitInBackground');
        expect(eventEmitterScript).toContain('Promise.resolve(listener.apply(this, args))');
        expect(openIdentity.match(/backgroundChatEvents: true/g)).toHaveLength(2);
        expect(appScript).toContain('pendingWorkspaceChatEvents = delay(0)');
        expect(appScript).toContain('eventSource.emitInBackground(event_types.CHAT_CHANGED, chatId)');
        expect(flushPending).toContain('await pendingWorkspaceChatEvents');
    });

    test('uses the validated same-origin direct bridge for the commit handshake', () => {
        expect(shellScript).toContain("const DIRECT_SHELL_RECEIVER = '__sillyTavernChatWorkspaceShellReceive'");
        expect(shellScript).toContain('source !== slot.frame.contentWindow');
        expect(shellScript).toContain('target.postMessage(message, location.origin)');
        expect(bridgeScript).toContain("const DIRECT_CHILD_RECEIVER = '__sillyTavernChatWorkspaceChildReceive'");
        expect(bridgeScript).toContain('source !== globalThis.parent');
        expect(bridgeScript).toContain('globalThis.parent.postMessage(message, globalThis.location.origin)');

        const navigate = bridgeScript.slice(
            bridgeScript.indexOf('async function navigate'),
            bridgeScript.indexOf('export function initChatWorkspaceBridge'),
        );
        expect(navigate.indexOf('navigationTiming.preparedAt = getTimingNow()'))
            .toBeLessThan(navigate.indexOf("post('prepared'"));
    });
});
