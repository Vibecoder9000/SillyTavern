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
        expect(bridgeScript).toContain("measureNavigationStage('chatFlush', () => bridgeApi.flushPendingChat())");
        expect(bridgeScript).toContain("document.addEventListener('beforeinput', blockInactiveEditableInput, true)");
        expect(bridgeScript).toContain('blurWorkspaceFocus();');
    });

    test('flushes global settings only after the shell commits the destination', () => {
        const queueNavigation = bridgeScript.slice(
            bridgeScript.indexOf('function queueWorkspaceNavigation'),
            bridgeScript.indexOf('function requestTabActivation'),
        );
        const activeHandler = bridgeScript.slice(
            bridgeScript.indexOf("if (message.type === 'active')"),
            bridgeScript.indexOf("if (message.type === 'persona-state')"),
        );
        expect(queueNavigation).not.toContain('flushGlobalSettings');
        expect(activeHandler).toContain('void runInBackground(() => bridgeApi.flushGlobalSettings()');
        expect(activeHandler).not.toContain('await bridgeApi.flushGlobalSettings()');
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

    test('allows only explicitly detachable generation to navigate', () => {
        expect(bridgeScript).toContain('latestTabsState.navigationBlocked');
        expect(shellScript).toContain('isSessionNavigationBlocked(activeSession)');
        expect(shellScript).toContain('canNavigateWhileGenerating: session.canNavigateWhileGenerating');
        expect(shellScript).toContain("type: 'blocked-generating'");
    });

    test('pauses before navigation and resumes only after the destination chat is restored', () => {
        const queueNavigation = bridgeScript.slice(
            bridgeScript.indexOf('function queueWorkspaceNavigation'),
            bridgeScript.indexOf('function requestTabActivation'),
        );
        const navigate = bridgeScript.slice(
            bridgeScript.indexOf('async function navigate'),
            bridgeScript.indexOf('export function initChatWorkspaceBridge'),
        );
        expect(queueNavigation.indexOf('pauseWorkspaceGeneration')).toBeLessThan(queueNavigation.indexOf('flushPendingChat'));
        expect(navigate.indexOf('restoreView')).toBeLessThan(navigate.indexOf('resumeWorkspaceGeneration'));
        expect(navigate.indexOf('resumeWorkspaceGeneration')).toBeLessThan(navigate.indexOf("post('prepared'"));
    });

    test('drains hidden streams but holds presentation and completion until resume', () => {
        const processor = appScript.slice(
            appScript.indexOf('class StreamingProcessor'),
            appScript.indexOf('/**\n * Constructs a prompt'),
        );
        expect(processor).toContain('workspaceNeedsCatchUp = true');
        expect(processor).toContain('continue;');
        expect(processor).toContain('await this.#waitForWorkspaceResume();');
        expect(processor.indexOf('await this.#waitForWorkspaceResume();')).toBeLessThan(processor.lastIndexOf('this.isFinished = true'));
        expect(appScript).toContain("['normal', 'swipe'].includes(type)");
    });

    test('makes swipe TTFT detachable and releases the global swipe lock while hidden', () => {
        const streamingBranch = appScript.slice(
            appScript.indexOf("if (isStreamingEnabled() && type !== 'quiet')"),
            appScript.indexOf('} else {\n            return await sendGenerationRequest'),
        );
        expect(streamingBranch.indexOf('prepareWorkspaceStreaming()')).toBeLessThan(streamingBranch.indexOf('sendStreamingRequest'));

        const pauseGeneration = appScript.slice(
            appScript.indexOf('async function pauseWorkspaceGeneration'),
            appScript.indexOf('async function flushWorkspacePendingChat'),
        );
        expect(pauseGeneration).toContain("processor.type === 'swipe'");
        expect(pauseGeneration).toContain('swipeState = SWIPE_STATE.NONE');

        const generationUi = appScript.slice(
            appScript.indexOf('function setWorkspaceGenerationUi'),
            appScript.indexOf('function registerWorkspaceStreamingProcessor'),
        );
        expect(generationUi).toContain('swipeState = SWIPE_STATE.SWIPING');
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
