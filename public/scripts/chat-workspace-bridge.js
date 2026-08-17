import { getAdjacentSessionId } from './chat-workspace-state.js';

const query = new URLSearchParams(location.search);
const runtimeId = query.get('workspaceRuntime');
let assignedSessionId = null;
let settingsRevision = Number(query.get('workspaceRevision')) || 0;
let workspaceActive = query.get('workspaceActive') !== '0';
let navigationDepth = 0;
let initialized = false;
let bridgeApi = null;
let stateTimer = null;
const tabElements = new Map();
let lastRevealedSessionId = null;
let pendingPersonaAvatar = null;
let latestTabsState = null;
let themeStateTimer = null;
let navigationRequestPending = false;
let bootStage = 'starting';
const activityLabels = {
    saving: 'Saving',
    opening: 'Opening',
    generating: 'Writing',
    waiting: 'Reply',
    error: 'Error',
    unread: 'New',
};
const statusLabels = {
    saving: 'saving',
    opening: 'opening',
    generating: 'generating',
    waiting: 'waiting for you',
    error: 'error',
    unread: 'unread response',
};

export function isChatWorkspaceChild() {
    return Boolean(runtimeId && parent !== self);
}

export function isChatWorkspaceInteractionActive() {
    return !isChatWorkspaceChild() || workspaceActive;
}

function isWorkspaceNavigationCommand() {
    return navigationDepth > 0;
}

export function canPersistWorkspaceGlobals() {
    return !isChatWorkspaceChild() || workspaceActive;
}

function post(type, payload = {}) {
    if (!isChatWorkspaceChild()) return;
    globalThis.parent.postMessage({
        source: 'sillytavern-chat-workspace',
        type,
        runtimeId,
        sessionId: assignedSessionId,
        ...payload,
    }, globalThis.location.origin);
}

export function reportWorkspaceBootProgress(stage) {
    if (!isChatWorkspaceChild()) return;
    bootStage = String(stage || 'starting');
    post('boot-progress', { stage: bootStage });
}

export function reportWorkspaceBootError(error) {
    if (!isChatWorkspaceChild()) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    post('boot-error', { stage: bootStage, message });

    const params = new URLSearchParams({ stage: bootStage, message });
    void fetch(`/api/chat-workspace/client-error?${params}`, { cache: 'no-store' }).catch(() => {});
}

function stopWorkspaceTabPropagation(event) {
    event.stopPropagation();
}

function blurWorkspaceFocus() {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
}

function reportNavigationError(error) {
    console.error('Could not save the current chat before switching', error);
    globalThis.toastr?.error?.('Could not save the current chat. Chat switching was cancelled.');
}

function queueWorkspaceNavigation(type, payload, optimisticSessionId = null) {
    if (!workspaceActive
        || !latestTabsState
        || navigationRequestPending
        || latestTabsState.pendingSessionId
        || latestTabsState.navigationBlocked) return false;
    navigationRequestPending = true;
    blurWorkspaceFocus();
    if (optimisticSessionId) renderTabs({ ...latestTabsState, pendingSessionId: optimisticSessionId });
    void (async () => {
        await bridgeApi.flushPendingChat();
        await bridgeApi.flushGlobalSettings();
        post(type, { ...payload, state: bridgeApi.getState() });
    })().catch(error => {
        navigationRequestPending = false;
        if (latestTabsState) renderTabs({ ...latestTabsState, pendingSessionId: null });
        reportNavigationError(error);
    });
    return true;
}

function requestTabActivation(targetSessionId) {
    if (!workspaceActive || !latestTabsState) return false;
    const selectedSessionId = latestTabsState.pendingSessionId || latestTabsState.activeSessionId;
    if (targetSessionId === selectedSessionId) return false;
    return queueWorkspaceNavigation('activate-chat', { targetSessionId }, targetSessionId);
}

function getWorkspaceThemeState() {
    const styles = getComputedStyle(document.documentElement);
    return {
        backgroundColor: styles.getPropertyValue('--SmartThemeBlurTintColor').trim() || styles.backgroundColor,
        foregroundColor: styles.getPropertyValue('--SmartThemeBodyColor').trim() || styles.color,
    };
}

function notifyWorkspaceThemeState() {
    if (!isChatWorkspaceChild() || !workspaceActive) return;
    clearTimeout(themeStateTimer);
    themeStateTimer = setTimeout(() => post('theme-state', { theme: getWorkspaceThemeState() }), 25);
}

function setWorkspaceActive(active) {
    workspaceActive = active;
    if (!active) blurWorkspaceFocus();
}

function activateAdjacentChat(direction) {
    if (!workspaceActive || !latestTabsState) return false;
    const currentSessionId = latestTabsState.pendingSessionId || latestTabsState.activeSessionId;
    const targetSessionId = getAdjacentSessionId(latestTabsState.sessions, currentSessionId, direction);
    return targetSessionId ? requestTabActivation(targetSessionId) : false;
}

function handleWorkspaceShortcut(event) {
    if (event.isComposing || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if (!['z', 'x'].includes(key)) return;

    const altShortcut = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!altShortcut || !activateAdjacentChat(key === 'z' ? -1 : 1)) return;
    event.preventDefault();
    event.stopPropagation();
}

function renderTabs(tabs) {
    const container = document.querySelector('#chat_workspace_tabs');
    if (!container) return;
    latestTabsState = tabs;
    if (!tabs.pendingSessionId && tabs.activeSessionId === assignedSessionId) navigationRequestPending = false;
    container.hidden = tabs.sessions.length < 2;
    container.setAttribute('aria-keyshortcuts', 'Alt+Z Alt+X');
    const liveSessionIds = new Set(tabs.sessions.map(session => session.id));

    for (const [sessionId, elements] of tabElements) {
        if (liveSessionIds.has(sessionId)) continue;
        elements.tab.remove();
        tabElements.delete(sessionId);
    }

    let nextElement = container.firstElementChild;
    for (const session of tabs.sessions) {
        let elements = tabElements.get(session.id);
        if (!elements) {
            const tab = document.createElement('div');
            const select = document.createElement('button');
            const avatar = document.createElement('img');
            const title = document.createElement('span');
            const activity = document.createElement('span');
            const close = document.createElement('button');

            tab.setAttribute('role', 'presentation');
            select.type = 'button';
            select.className = 'chat_workspace_tab_select';
            select.setAttribute('role', 'tab');
            select.addEventListener('pointerdown', stopWorkspaceTabPropagation);
            select.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                document.querySelector('#send_textarea')?.blur();
                requestTabActivation(session.id);
            });
            select.addEventListener('keydown', event => {
                if (!workspaceActive || !latestTabsState) return;
                const currentSessionId = latestTabsState.pendingSessionId || latestTabsState.activeSessionId;
                let targetSessionId = null;
                if (event.key === 'ArrowLeft') {
                    targetSessionId = getAdjacentSessionId(latestTabsState.sessions, currentSessionId, -1);
                } else if (event.key === 'ArrowRight') {
                    targetSessionId = getAdjacentSessionId(latestTabsState.sessions, currentSessionId, 1);
                } else if (event.key === 'Home') {
                    targetSessionId = latestTabsState.sessions[0]?.id || null;
                } else if (event.key === 'End') {
                    targetSessionId = latestTabsState.sessions.at(-1)?.id || null;
                }
                if (!targetSessionId || targetSessionId === currentSessionId) return;
                event.preventDefault();
                event.stopPropagation();
                requestTabActivation(targetSessionId);
            });
            avatar.className = 'chat_workspace_tab_avatar';
            avatar.alt = '';
            title.className = 'chat_workspace_tab_title';
            activity.className = 'chat_workspace_tab_activity';
            activity.setAttribute('aria-hidden', 'true');
            close.type = 'button';
            close.className = 'chat_workspace_tab_close';
            close.textContent = '\u00d7';
            close.addEventListener('pointerdown', stopWorkspaceTabPropagation);
            close.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                document.querySelector('#send_textarea')?.blur();
                post('close-chat', {
                    targetSessionId: session.id,
                    state: session.id === assignedSessionId ? bridgeApi.getState() : null,
                });
            });
            select.append(avatar, title, activity);
            tab.append(select, close);
            elements = { tab, select, avatar, title, activity, close };
            tabElements.set(session.id, elements);
        }

        const { tab, select, avatar, title, activity, close } = elements;
        tab.className = 'chat_workspace_tab';
        tab.classList.toggle('active', session.id === tabs.activeSessionId);
        tab.classList.toggle('pending', session.id === tabs.pendingSessionId);
        tab.classList.toggle('saving', Boolean(session.saving));
        tab.classList.toggle('generating', session.status === 'generating');
        tab.classList.toggle('waiting', session.status === 'waiting');
        tab.classList.toggle('error', session.status === 'error');
        tab.classList.toggle('unread', Boolean(session.unread));
        select.setAttribute('aria-selected', session.id === tabs.activeSessionId ? 'true' : 'false');
        select.tabIndex = session.id === (tabs.pendingSessionId || tabs.activeSessionId) ? 0 : -1;
        select.disabled = Boolean(tabs.pendingSessionId)
            || Boolean(tabs.navigationBlocked && session.id !== tabs.activeSessionId);
        select.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
        avatar.classList.toggle('empty', !session.avatar);
        if (session.avatar && avatar.dataset.src !== session.avatar) {
            avatar.src = session.avatar;
            avatar.dataset.src = session.avatar;
        } else if (!session.avatar && avatar.dataset.src) {
            avatar.removeAttribute('src');
            delete avatar.dataset.src;
        }
        title.textContent = session.title || 'Home';
        const statusKey = session.saving
            ? 'saving'
            : session.id === tabs.pendingSessionId
                ? 'opening'
                : session.status !== 'idle'
                    ? session.status
                    : session.unread ? 'unread' : '';
        // A pending tab's spinner is sufficient feedback. Keep the accessible
        // status on the tab button without adding shifting "Opening" text.
        activity.textContent = statusKey === 'opening' ? '' : activityLabels[statusKey] || '';

        close.disabled = Boolean(session.busy || tabs.pendingSessionId);
        const closeLabel = session.busy
            ? `Cannot close ${session.title || 'chat'} while it is busy`
            : `Close ${session.title || 'chat'}`;
        close.title = closeLabel;
        close.setAttribute('aria-label', closeLabel);
        const statusLabel = statusLabels[statusKey] || '';
        select.title = statusLabel
            ? `${session.title || 'Chat'} \u2014 ${statusLabel}`
            : session.title || 'Open chat';
        select.setAttribute('aria-label', statusLabel
            ? `${session.title || 'Chat'}, ${statusLabel}`
            : session.title || 'Open chat');
        if (tab !== nextElement) container.insertBefore(tab, nextElement);
        nextElement = tab.nextElementSibling;
    }

    const revealedSessionId = tabs.pendingSessionId || tabs.activeSessionId;
    if (revealedSessionId && revealedSessionId !== lastRevealedSessionId) {
        tabElements.get(revealedSessionId)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        lastRevealedSessionId = revealedSessionId;
    }
}

export function requestWorkspaceOpen(identity, presentation = null) {
    if (!isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand()) return false;
    if (!queueWorkspaceNavigation('open-chat', { identity, presentation })) {
        globalThis.toastr?.warning?.(latestTabsState?.navigationBlocked
            ? 'Wait for generation to finish before switching chats.'
            : 'A chat is already being opened.');
    }
    // Consume workspace navigation requests even when blocked so callers do not
    // fall back to mutating the currently assigned runtime in place.
    return true;
}

export function requestWorkspaceNewChat(identity, presentation = null) {
    if (!isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand() || !identity) return false;
    if (!queueWorkspaceNavigation('open-new-chat', { identity, presentation })) {
        globalThis.toastr?.warning?.(latestTabsState?.navigationBlocked
            ? 'Wait for generation to finish before creating another chat.'
            : 'A chat is already being opened.');
    }
    return true;
}

export function beginWorkspaceNewChat(identity) {
    if (!isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand() || !identity) return false;
    post('new-chat-starting', { identity });
    return true;
}

export function finishWorkspaceNewChat(success) {
    if (!isChatWorkspaceChild() || !initialized) return;
    post('new-chat-finished', {
        success,
        state: success ? bridgeApi.getState() : null,
    });
}

export function notifyWorkspaceState(state = null) {
    if (!isChatWorkspaceChild() || !bridgeApi) return;
    clearTimeout(stateTimer);
    if (state) {
        post('state', { state });
        return;
    }
    stateTimer = setTimeout(() => {
        post('state', { state: bridgeApi.getState() });
    }, 200);
}

export function notifyWorkspacePersonaChanged(avatar) {
    if (!isChatWorkspaceChild() || !workspaceActive || typeof avatar !== 'string' || !avatar) return;
    post('persona-changed', { avatar });
}

/**
 * Tells the workspace shell that the reusable iframe's extension revision
 * changed. The iframe reloads itself when the extension operation requires it.
 */
export function notifyWorkspaceExtensionChange() {
    if (!isChatWorkspaceChild()) return;
    post('extensions-changed');
}

async function navigate(requestId, targetSessionId, identity, restore = {}, personaAvatar = null) {
    navigationDepth++;
    try {
        if (identity) await bridgeApi.openIdentity(identity);
        await bridgeApi.restoreView(restore);
        await bridgeApi.onActivated(personaAvatar);
        // The application is prepared once its chat, view, and persona state
        // are restored. Loader popup disposal is visual cleanup and may wait
        // for an animation or popup lifecycle even after its DOM is gone; it
        // must not hold the shell loader open.
        try {
            void Promise.resolve(bridgeApi.hideLoader()).catch(error => {
                console.warn('Could not finish hiding the child loader', error);
            });
        } catch (error) {
            console.warn('Could not start hiding the child loader', error);
        }
        post('prepared', {
            requestId,
            targetSessionId,
            state: bridgeApi.getState(),
            settingsRevision,
        });
    } catch (error) {
        console.error('Could not open chat workspace session', error);
        post('navigation-error', {
            requestId,
            targetSessionId,
            message: error instanceof Error ? error.message : String(error),
        });
    } finally {
        navigationDepth--;
    }
}

export function initChatWorkspaceBridge(api) {
    if (!isChatWorkspaceChild() || initialized) return;
    initialized = true;
    bridgeApi = api;
    globalThis.addEventListener('message', event => {
        if (event.origin !== globalThis.location.origin || event.source !== globalThis.parent) return;
        const message = event.data;
        if (!message || message.source !== 'sillytavern-chat-workspace-shell' || message.runtimeId !== runtimeId) return;
        if (message.type === 'assign') {
            assignedSessionId = message.sessionId;
            settingsRevision = message.settingsRevision;
            pendingPersonaAvatar = message.personaAvatar || pendingPersonaAvatar;
            setWorkspaceActive(false);
            void navigate(message.requestId, message.sessionId, message.identity, message.restore, pendingPersonaAvatar).finally(() => {
                pendingPersonaAvatar = null;
            });
        }
        if (message.type === 'tabs-state') renderTabs(message.tabs);
        if (message.type === 'activation-blocked') {
            navigationRequestPending = false;
            if (latestTabsState) renderTabs({ ...latestTabsState, pendingSessionId: null });
            const text = message.reason === 'generating'
                ? 'Wait for generation to finish before switching chats.'
                : message.reason === 'failed'
                    ? 'Could not restore the previous chat. Reload the workspace and try again.'
                    : 'A chat is already being opened.';
            globalThis.toastr?.warning?.(text);
        }
        if (message.type === 'active') {
            setWorkspaceActive(message.active);
            if (message.active) globalThis.toastr?.clear?.(undefined, { force: true });
        }
        if (message.type === 'persona-state' && typeof message.avatar === 'string') pendingPersonaAvatar = message.avatar;
        if (message.type === 'request-state') notifyWorkspaceState();
        if (message.type === 'extensions-reload') {
            globalThis.location.reload();
        }
        if (message.type === 'confirm-close') {
            void bridgeApi.confirmClose(message.session).then(confirmed => {
                if (confirmed) {
                    post('close-chat', {
                        targetSessionId: message.targetSessionId,
                        discardDraft: true,
                    });
                }
            }).catch(error => {
                console.error('Could not confirm closing a workspace chat', error);
            });
        }
        if (message.type === 'create-new-chat') {
            void bridgeApi.createNewChat().catch(error => {
                console.error('Could not create a new workspace chat', error);
            });
        }
    });

    document.querySelector('#send_textarea')?.addEventListener('input', () => notifyWorkspaceState());
    const blockInactiveEditableInput = event => {
        if (isChatWorkspaceInteractionActive()) return;
        const target = event.target;
        if (!(target instanceof Element) || !target.matches('input, textarea, [contenteditable="true"]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    document.addEventListener('beforeinput', blockInactiveEditableInput, true);
    document.addEventListener('keydown', blockInactiveEditableInput, true);
    document.addEventListener('keydown', handleWorkspaceShortcut);
    document.querySelector('#chat')?.addEventListener('scroll', () => notifyWorkspaceState(), { passive: true });
    const askUserPanel = document.querySelector('#ask_user_panel');
    if (askUserPanel) {
        new MutationObserver(() => notifyWorkspaceState()).observe(askUserPanel, { attributes: true, attributeFilter: ['hidden'] });
    }
    new MutationObserver(notifyWorkspaceThemeState).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
    });
    globalThis.addEventListener('pagehide', () => {
        clearTimeout(stateTimer);
        post('state', { state: bridgeApi.getState() });
        post('unloading');
    });
    post('app-ready', {
        theme: getWorkspaceThemeState(),
        settingsRevision,
    });
}
