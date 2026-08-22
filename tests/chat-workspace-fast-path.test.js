import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const appScript = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const bridgeScript = readFileSync(new URL('../public/scripts/chat-workspace-bridge.js', import.meta.url), 'utf8');
const groupScript = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');

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
});
