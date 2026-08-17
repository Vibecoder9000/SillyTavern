import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const shellHtml = readFileSync(new URL('../public/chat-workspace.html', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../public/css/chat-workspace.css', import.meta.url), 'utf8');
const shellScript = readFileSync(new URL('../public/scripts/chat-workspace.js', import.meta.url), 'utf8');
const bridgeScript = readFileSync(new URL('../public/scripts/chat-workspace-bridge.js', import.meta.url), 'utf8');
const appScript = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const rossModsScript = readFileSync(new URL('../public/scripts/RossAscends-mods.js', import.meta.url), 'utf8');

describe('chat workspace initial loading surface', () => {
    test('covers a render-active preparing runtime with the shell loader', () => {
        expect(shellHtml).toContain('href="css/loader.css"');
        expect(shellHtml).toContain('id="preloader"');
        expect(shellHtml).toContain('id="loader" class="splash-screen"');
        expect(shellHtml).toContain('id="load-spinner" class="fa-solid fa-gear fa-spin fa-3x"');
        expect(shellHtml).toContain('class="splash-message"');
        expect(shellScript).toContain("frame.className = 'chat-workspace-frame active'");
        expect(shellCss).not.toMatch(/\.chat-workspace-frame\s*\{[^}]*(?:visibility:\s*hidden|display:\s*none)/s);
        expect(shellCss).not.toContain('chat-workspace-loader-spinner');
    });

    test('hides the shell loader only in the atomic runtime commit callback', () => {
        const commitCallback = shellScript.slice(shellScript.indexOf('setSlotActive:'), shellScript.indexOf('function postAssignment'));
        expect(commitCallback).toContain("slot.frame.classList.add('active')");
        expect(commitCallback).toContain('loaderElement.hidden = true');
        expect(readFileSync(new URL('../public/scripts/chat-workspace-runtime.js', import.meta.url), 'utf8'))
            .not.toContain('requestAnimationFrame');
    });

    test('does not cover an already running workspace while switching chats', () => {
        const requestActivation = shellScript.slice(
            shellScript.indexOf('function requestActivation'),
            shellScript.indexOf('function applyWorkspaceTheme'),
        );
        expect(requestActivation).not.toContain('loaderElement.hidden = false');
    });

    test('shows only the spinner for a pending tab', () => {
        const renderTabs = bridgeScript.slice(
            bridgeScript.indexOf('function renderTabs'),
            bridgeScript.indexOf('export function requestWorkspaceOpen'),
        );
        expect(renderTabs).toContain("activity.textContent = statusKey === 'opening' ? ''");
        expect(renderTabs).toContain("statusLabels[statusKey]");
    });

    test('restores child view state without waiting for an occlusion-sensitive animation frame', () => {
        const restoreView = appScript.slice(
            appScript.indexOf('function restoreWorkspaceView'),
            appScript.indexOf('function initInAppChatWorkspace'),
        );
        expect(restoreView).toContain('chatView.scrollTop = restore.scrollTop || 0');
        expect(restoreView).not.toContain('requestAnimationFrame');
    });

    test('does not gate preparation on child loader popup disposal', () => {
        const navigate = bridgeScript.slice(
            bridgeScript.indexOf('async function navigate'),
            bridgeScript.indexOf('export function initChatWorkspaceBridge'),
        );
        expect(navigate).toContain('bridgeApi.hideLoader()');
        expect(navigate).not.toContain('await bridgeApi.hideLoader()');
        expect(navigate.indexOf("post('prepared'")).toBeGreaterThan(navigate.indexOf('bridgeApi.hideLoader()'));
    });

    test('captures outgoing state and blocks input in inactive runtimes', () => {
        expect(bridgeScript).toContain('state: bridgeApi.getState()');
        expect(bridgeScript).toContain('await bridgeApi.flushPendingChat();');
        expect(bridgeScript).toContain('await bridgeApi.flushGlobalSettings();');
        expect(bridgeScript).toContain("document.addEventListener('beforeinput', blockInactiveEditableInput, true)");
        expect(bridgeScript).toContain('blurWorkspaceFocus();');
    });

    test('owns one runtime and has no spare or cache lifecycle', () => {
        expect(shellScript).toContain('requestActivation(startupSessionId);');
        expect(shellScript).not.toContain('ensureSpare');
        expect(shellScript).not.toContain('enforceBounds');
        expect(shellScript).not.toContain('prepare-spare');
    });

    test('the workspace runtime waits for assignment instead of auto-loading the global chat', () => {
        expect(bridgeScript).toContain("if (message.type === 'assign')");
        expect(bridgeScript).not.toContain("message.type === 'prepare-spare'");
        expect(rossModsScript).toContain('if (power_user.auto_load_chat && !isChatWorkspaceChild())');
    });

    test('assignment sends the pending target identity rather than the uncommitted slot identity', () => {
        const postAssignment = shellScript.slice(
            shellScript.indexOf('function postAssignment'),
            shellScript.indexOf('function getTabsState'),
        );
        expect(postAssignment).toMatch(/postToSlot\(slot, 'assign', \{\s*(?:\/\/[\s\S]*?\n\s*)?sessionId,/);
    });

    test('blocks navigation during generation at both child and shell boundaries', () => {
        expect(bridgeScript).toContain('latestTabsState.navigationBlocked');
        expect(shellScript).toContain('isSessionGenerating(activeSession)');
        expect(shellScript).toContain("type: 'blocked-generating'");
    });

    test('reassigns the active logical session after the sole iframe reloads', () => {
        const unloadingHandler = shellScript.slice(
            shellScript.indexOf("if (message.type === 'unloading')"),
            shellScript.indexOf("if (message.type === 'prepared')"),
        );
        expect(unloadingHandler).toContain('runtimeController.markUnloaded(slot.id)');
        expect(unloadingHandler).toContain("requestActivation(runtimeController.activeSessionId, { force: true, recovering: true })");
    });
});
