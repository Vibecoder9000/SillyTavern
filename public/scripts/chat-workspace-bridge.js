import { getAdjacentSessionId } from './chat-workspace-state.js';

const query = new URLSearchParams(location.search);
const DIRECT_SHELL_RECEIVER = '__sillyTavernChatWorkspaceShellReceive';
const DIRECT_CHILD_RECEIVER = '__sillyTavernChatWorkspaceChildReceive';
const runtimeId = query.get('workspaceRuntime');
let assignedSessionId = null;
let assignedIdentity = null;
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
let navigationTiming = null;
let bootStage = 'starting';
let workspaceTabsEnabled = true;
let tabsDisableRequestSequence = 0;
let pendingTabsDisableRequest = null;
const TRANSIENT_ACTIVITY_DELAY = 400;
const TABS_DISABLE_REQUEST_TIMEOUT = 10000;
const statusLabels = {
    saving: 'saving',
    opening: 'opening',
    generating: 'generating',
    waiting: 'waiting for you',
    error: 'error',
    unread: 'unread response',
};

function setTabActivity(elements, statusKey) {
    const { activity } = elements;
    const transient = statusKey === 'saving' || statusKey === 'opening';
    elements.requestedActivity = statusKey;

    if (elements.activityTimer && elements.activityTimerStatus !== statusKey) {
        clearTimeout(elements.activityTimer);
        elements.activityTimer = null;
        elements.activityTimerStatus = '';
    }

    if (!transient) {
        if (elements.activityTimer) clearTimeout(elements.activityTimer);
        elements.activityTimer = null;
        elements.activityTimerStatus = '';
        activity.dataset.status = statusKey;
        return;
    }

    if (activity.dataset.status === statusKey || elements.activityTimer) return;
    // Opening and saving commonly finish within a single perceptual moment.
    // Retain any useful existing state and only reveal these indicators when
    // the operation lasts long enough for feedback to help instead of flash.
    if (!activity.dataset.status || ['opening', 'saving'].includes(activity.dataset.status)) {
        activity.dataset.status = '';
    }
    elements.activityTimerStatus = statusKey;
    elements.activityTimer = setTimeout(() => {
        elements.activityTimer = null;
        elements.activityTimerStatus = '';
        if (elements.requestedActivity === statusKey) activity.dataset.status = statusKey;
    }, TRANSIENT_ACTIVITY_DELAY);
}

export function isChatWorkspaceChild() {
    return Boolean(runtimeId && parent !== self);
}

export function isChatWorkspaceInteractionActive() {
    return !isChatWorkspaceChild() || workspaceActive;
}

export function getChatWorkspaceSessionId() {
    return assignedSessionId;
}

export function getChatWorkspaceTabCount() {
    return latestTabsState?.sessions?.length || 0;
}

export function setChatWorkspaceTabsEnabled(enabled) {
    workspaceTabsEnabled = enabled !== false;
    document.body.classList.toggle('chat-workspace-tabs-disabled', !workspaceTabsEnabled);

    const container = document.querySelector('#chat_workspace_tabs');
    if (!container) return;
    if (latestTabsState) {
        renderTabs(latestTabsState);
    } else if (!workspaceTabsEnabled) {
        container.hidden = true;
        container.removeAttribute('aria-keyshortcuts');
    }
}

export function requestWorkspaceTabsDisable() {
    if (!isChatWorkspaceChild() || !initialized || !workspaceActive || getChatWorkspaceTabCount() < 2) {
        return Promise.resolve(true);
    }

    const requestId = ++tabsDisableRequestSequence;
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            if (pendingTabsDisableRequest?.requestId !== requestId) return;
            pendingTabsDisableRequest = null;
            globalThis.toastr?.error?.('Could not disable chat tabs. Please try again.');
            resolve(false);
        }, TABS_DISABLE_REQUEST_TIMEOUT);
        pendingTabsDisableRequest = { requestId, resolve, timeout };
        post('disable-tabs', { requestId });
    });
}

function isWorkspaceNavigationCommand() {
    return navigationDepth > 0;
}

export function canPersistWorkspaceGlobals() {
    return !isChatWorkspaceChild() || workspaceActive;
}

function post(type, payload = {}) {
    if (!isChatWorkspaceChild()) return;
    const message = {
        source: 'sillytavern-chat-workspace',
        type,
        runtimeId,
        sessionId: assignedSessionId,
        ...payload,
    };

    // Both workspace documents are same-origin. A direct receiver avoids two
    // queued window-message tasks on the tab-switch handshake while retaining
    // postMessage as the startup/failure fallback.
    let receiver = null;
    try {
        receiver = globalThis.parent?.[DIRECT_SHELL_RECEIVER];
    } catch {
        // Cross-window access can fail while either document is navigating.
    }
    if (typeof receiver === 'function') {
        receiver(message, globalThis);
        return;
    }
    globalThis.parent.postMessage(message, globalThis.location.origin);
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
    console.error('Could not prepare the current chat for switching', error);
    const detail = error instanceof Error ? error.message : 'Could not save the current chat.';
    globalThis.toastr?.error?.(`${detail} Chat switching was cancelled.`);
}

async function runInBackground(callback, warning) {
    try {
        await callback();
    } catch (error) {
        console.warn(warning, error);
    }
}

function getTimingNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

function beginNavigationTiming(type, targetSessionId) {
    navigationTiming = {
        type,
        targetSessionId,
        startedAt: getTimingNow(),
        handoffStartedAt: null,
        preparedAt: null,
        stages: {},
    };
}

async function measureNavigationStage(name, callback) {
    const startedAt = getTimingNow();
    try {
        return await callback();
    } finally {
        if (navigationTiming) {
            navigationTiming.stages[name] = (navigationTiming.stages[name] || 0) + getTimingNow() - startedAt;
        }
    }
}

function finishNavigationTiming(outcome) {
    if (!navigationTiming) return;
    const finishedAt = getTimingNow();
    const stages = Object.fromEntries(Object.entries(navigationTiming.stages)
        .map(([name, duration]) => [name, Number(duration.toFixed(1))]));
    console.info('[Chat workspace] Tab switch timing', {
        type: navigationTiming.type,
        outcome,
        stagesMs: stages,
        totalMs: Number((finishedAt - navigationTiming.startedAt).toFixed(1)),
    });
    navigationTiming = null;
}

function queueWorkspaceNavigation(type, payload, optimisticSessionId = null) {
    if (!workspaceTabsEnabled
        || !workspaceActive
        || !latestTabsState
        || navigationRequestPending
        || latestTabsState.pendingSessionId
        || latestTabsState.navigationBlocked) return false;
    navigationRequestPending = true;
    beginNavigationTiming(type, optimisticSessionId);
    blurWorkspaceFocus();
    if (optimisticSessionId) renderTabs({ ...latestTabsState, pendingSessionId: optimisticSessionId });
    void (async () => {
        await measureNavigationStage('pause', () => bridgeApi.pauseWorkspaceGeneration?.(assignedSessionId));
        await measureNavigationStage('chatFlush', () => bridgeApi.flushPendingChat());
        if (navigationTiming) navigationTiming.handoffStartedAt = getTimingNow();
        post(type, { ...payload, state: bridgeApi.getState() });
    })().catch(error => {
        navigationRequestPending = false;
        if (latestTabsState) renderTabs({ ...latestTabsState, pendingSessionId: null });
        void bridgeApi.resumeWorkspaceGeneration?.(assignedSessionId);
        finishNavigationTiming('error');
        reportNavigationError(error);
    });
    return true;
}

function requestTabActivation(targetSessionId) {
    if (!workspaceTabsEnabled || !workspaceActive || !latestTabsState) return false;
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
    if (!workspaceTabsEnabled || !workspaceActive || !latestTabsState) return false;
    const currentSessionId = latestTabsState.pendingSessionId || latestTabsState.activeSessionId;
    const targetSessionId = getAdjacentSessionId(latestTabsState.sessions, currentSessionId, direction);
    return targetSessionId ? requestTabActivation(targetSessionId) : false;
}

function handleWorkspaceShortcut(event) {
    if (!workspaceTabsEnabled || event.isComposing || event.defaultPrevented) return;
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
    container.hidden = !workspaceTabsEnabled || tabs.sessions.length < 2;
    if (workspaceTabsEnabled) {
        container.setAttribute('aria-keyshortcuts', 'Alt+Z Alt+X');
    } else {
        container.removeAttribute('aria-keyshortcuts');
    }
    const liveSessionIds = new Set(tabs.sessions.map(session => session.id));

    for (const [sessionId, elements] of tabElements) {
        if (liveSessionIds.has(sessionId)) continue;
        if (elements.activityTimer) clearTimeout(elements.activityTimer);
        elements.tab.remove();
        tabElements.delete(sessionId);
    }
    for (const elements of tabElements.values()) {
        elements.select.removeAttribute('data-workspace-shortcut');
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
                if (!workspaceTabsEnabled || !workspaceActive || !latestTabsState) return;
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
            elements = { tab, select, avatar, title, activity, close, requestedActivity: '', activityTimer: null, activityTimerStatus: '' };
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
        // The compact icon is sufficient visual feedback. Full status text is
        // retained in the tooltip and accessible name below.
        activity.textContent = '';
        setTabActivity(elements, statusKey);

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

    const selectedSessionId = tabs.pendingSessionId || tabs.activeSessionId;
    const shortcutTargets = new Map();
    const addShortcut = (sessionId, shortcut) => {
        if (!sessionId || shortcutTargets.has(sessionId)) return;
        shortcutTargets.set(sessionId, shortcut);
    };
    addShortcut(getAdjacentSessionId(tabs.sessions, selectedSessionId, -1), 'Alt+Z');
    addShortcut(getAdjacentSessionId(tabs.sessions, selectedSessionId, 1), 'Alt+X');
    for (const [sessionId, shortcut] of shortcutTargets) {
        tabElements.get(sessionId)?.select.setAttribute('data-workspace-shortcut', shortcut);
    }

    const revealedSessionId = selectedSessionId;
    if (revealedSessionId && revealedSessionId !== lastRevealedSessionId) {
        tabElements.get(revealedSessionId)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        lastRevealedSessionId = revealedSessionId;
    }
}

export function requestWorkspaceOpen(identity, presentation = null, { showOwnerUi = false, onAccepted = null } = {}) {
    if (!workspaceTabsEnabled || !isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand()) return false;
    if (!queueWorkspaceNavigation('open-chat', { identity, presentation, showOwnerUi })) {
        globalThis.toastr?.warning?.(latestTabsState?.navigationBlocked
            ? 'Wait for generation to finish before switching chats.'
            : 'A chat is already being opened.');
    } else if (typeof onAccepted === 'function') {
        onAccepted();
    }
    // Consume workspace navigation requests even when blocked so callers do not
    // fall back to mutating the currently assigned runtime in place.
    return true;
}

export function requestWorkspaceNewChat(identity, presentation = null) {
    if (!workspaceTabsEnabled || !isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand() || !identity) return false;
    if (!queueWorkspaceNavigation('open-new-chat', { identity, presentation })) {
        globalThis.toastr?.warning?.(latestTabsState?.navigationBlocked
            ? 'Wait for generation to finish before creating another chat.'
            : 'A chat is already being opened.');
    }
    return true;
}

export function beginWorkspaceNewChat(identity) {
    if (!workspaceTabsEnabled || !isChatWorkspaceChild() || !initialized || !workspaceActive || isWorkspaceNavigationCommand() || !identity) return false;
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

async function navigate(requestId, targetSessionId, identity, restore = {}, personaAvatar = null, previousSessionId = assignedSessionId, showOwnerUi = false) {
    navigationDepth++;
    try {
        if (navigationTiming) {
            navigationTiming.targetSessionId = targetSessionId;
            if (navigationTiming.handoffStartedAt !== null) {
                navigationTiming.stages.shellHandoff = getTimingNow() - navigationTiming.handoffStartedAt;
            }
        }
        if (previousSessionId && previousSessionId !== targetSessionId) {
            await measureNavigationStage('pause', () => bridgeApi.pauseWorkspaceGeneration?.(previousSessionId));
        }
        assignedSessionId = targetSessionId;
        assignedIdentity = identity;
        if (identity) await bridgeApi.openIdentity(identity, measureNavigationStage, { showOwnerUi });
        await measureNavigationStage('viewRestore', () => bridgeApi.restoreView(restore));
        await measureNavigationStage('personaActivation', () => bridgeApi.onActivated(personaAvatar));
        await measureNavigationStage('generationResume', () => bridgeApi.resumeWorkspaceGeneration?.(targetSessionId));
        // The application is prepared once its chat, view, and persona state
        // are restored. Loader popup disposal is visual cleanup and may wait
        // for an animation or popup lifecycle even after its DOM is gone; it
        // must not hold the shell loader open.
        void runInBackground(() => bridgeApi.hideLoader(), 'Could not finish hiding the child loader');
        const state = bridgeApi.getState();
        if (navigationTiming) navigationTiming.preparedAt = getTimingNow();
        post('prepared', {
            requestId,
            targetSessionId,
            state,
            settingsRevision,
        });
    } catch (error) {
        console.error('Could not open chat workspace session', error);
        post('navigation-error', {
            requestId,
            targetSessionId,
            message: error instanceof Error ? error.message : String(error),
        });
        finishNavigationTiming('error');
    } finally {
        navigationDepth--;
    }
}

export function initChatWorkspaceBridge(api) {
    if (!isChatWorkspaceChild() || initialized) return;
    initialized = true;
    bridgeApi = api;
    const receiveShellMessage = (message, source, origin) => {
        if (origin !== globalThis.location.origin || source !== globalThis.parent) return;
        if (!message || message.source !== 'sillytavern-chat-workspace-shell' || message.runtimeId !== runtimeId) return;
        if (message.type === 'assign') {
            const previousSessionId = assignedSessionId;
            settingsRevision = message.settingsRevision;
            pendingPersonaAvatar = message.personaAvatar || pendingPersonaAvatar;
            setWorkspaceActive(false);
            void navigate(message.requestId, message.sessionId, message.identity, message.restore, pendingPersonaAvatar, previousSessionId, message.showOwnerUi).finally(() => {
                pendingPersonaAvatar = null;
            });
        }
        if (message.type === 'tabs-state') renderTabs(message.tabs);
        if (message.type === 'tabs-disable-result') {
            if (pendingTabsDisableRequest?.requestId !== message.requestId) return;
            const pendingRequest = pendingTabsDisableRequest;
            pendingTabsDisableRequest = null;
            clearTimeout(pendingRequest.timeout);
            if (!message.accepted && message.reason === 'busy') {
                globalThis.toastr?.warning?.('Finish the other chat before disabling chat tabs.');
            }
            pendingRequest.resolve(message.accepted === true);
        }
        if (message.type === 'activation-blocked') {
            navigationRequestPending = false;
            if (latestTabsState) renderTabs({ ...latestTabsState, pendingSessionId: null });
            void bridgeApi.resumeWorkspaceGeneration?.(assignedSessionId);
            finishNavigationTiming('blocked');
            const text = message.reason === 'generating'
                ? 'Wait for generation to finish before switching chats.'
                : message.reason === 'failed'
                    ? 'Could not restore the previous chat. Reload the workspace and try again.'
                    : 'A chat is already being opened.';
            globalThis.toastr?.warning?.(text);
        }
        if (message.type === 'active') {
            setWorkspaceActive(message.active);
            if (message.active) {
                if (navigationTiming && navigationTiming.preparedAt !== null) {
                    navigationTiming.stages.commitHandshake = getTimingNow() - navigationTiming.preparedAt;
                }
                finishNavigationTiming('success');
                void runInBackground(() => bridgeApi.onCommitted?.(assignedIdentity), 'Could not finish post-commit workspace persistence');
                void runInBackground(() => bridgeApi.flushGlobalSettings(), 'Could not flush workspace settings after committing the tab');
                globalThis.toastr?.clear?.(undefined, { force: true });
            }
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
    };
    globalThis[DIRECT_CHILD_RECEIVER] = (message, source) => receiveShellMessage(message, source, globalThis.location.origin);
    globalThis.addEventListener('message', event => receiveShellMessage(event.data, event.source, event.origin));

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
