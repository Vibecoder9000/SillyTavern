import {
    SESSION_STATUS,
    createWorkspaceSession,
    createWorkspaceId,
    collapseWorkspaceSessions,
    findSessionByIdentity,
    getIdentityKey,
    hasPersistedSessionChanged,
    hasTabPresentationChanged,
    isSessionNavigationBlocked,
    isSessionBusy,
    normalizeIdentity,
    restoreWorkspace,
    serializeWorkspace,
} from './chat-workspace-state.js';
import { createCoalescedWriter } from './chat-workspace-persistence.js';
import { WorkspaceRuntimeController } from './chat-workspace-runtime.js';

const REMOTE_STATE_URL = '/api/chat-workspace/state';
const DIRECT_SHELL_RECEIVER = '__sillyTavernChatWorkspaceShellReceive';
const DIRECT_CHILD_RECEIVER = '__sillyTavernChatWorkspaceChildReceive';
// Draft and scroll updates can arrive for every keystroke/frame. Keep them in
// memory immediately, but wait for a real idle window before writing remotely.
const PERSIST_DELAY = 1500;
const framesElement = document.querySelector('#chat-workspace-frames');
const loaderElement = document.querySelector('#preloader');
const startupSearch = new URLSearchParams(location.search);
const startupHash = location.hash;
const newChatTransitions = new Map();
let pendingNewChatSessionId = null;
let activePersonaAvatar = null;
let globalSettingsRevision = 1;
let startupLocationClaimed = false;
let rollbackReloadAttempted = false;
let lastBootStage = 'starting';
let bootTimeout = null;
const ownerUiActivationSessions = new Set();

function setLoaderMessage(message, { error = false } = {}) {
    const messageElement = loaderElement?.querySelector('.splash-message');
    if (messageElement) messageElement.textContent = message;
    loaderElement?.toggleAttribute('data-error', error);
}

function armBootTimeout() {
    clearTimeout(bootTimeout);
    bootTimeout = setTimeout(() => {
        setLoaderMessage(`Startup stalled while ${lastBootStage}. Reload once; if it repeats, check the server console.`, { error: true });
    }, 90000);
}

async function loadWorkspaceState() {
    try {
        const response = await fetch(REMOTE_STATE_URL, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json())?.workspace || null;
    } catch (error) {
        console.warn('Could not load the account chat workspace; starting with a new workspace', error);
        return null;
    }
}

let csrfTokenPromise = null;
function getCsrfToken() {
    csrfTokenPromise ??= fetch('/csrf-token')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then(payload => payload.token);
    return csrfTokenPromise;
}

async function saveWorkspaceState(value) {
    const token = await getCsrfToken();
    const response = await fetch(REMOTE_STATE_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        },
        body: JSON.stringify(value),
        keepalive: true,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

const restored = restoreWorkspace(await loadWorkspaceState());
const sessions = restored.sessions;
const startupSessionId = restored.activeSessionId;
let startupLocationPending = startupSearch.size > 0 || Boolean(startupHash);

const persistence = createCoalescedWriter(async value => {
    try {
        await saveWorkspaceState(value);
    } catch (error) {
        console.warn('Could not persist the account chat workspace', error);
    }
}, { delay: PERSIST_DELAY });

function getPersistedSnapshot() {
    const activeId = runtimeController.activeSessionId
        || runtimeController.pendingSessionId
        || sessions[0]?.id;
    return serializeWorkspace(sessions, activeId);
}

function persist() {
    persistence.schedule(getPersistedSnapshot());
}

function getFrameUrl(runtimeId) {
    const url = new URL('/', location.origin);
    if (!startupLocationClaimed) {
        for (const [key, value] of startupSearch) {
            if (!['workspaceRuntime', 'workspaceActive', 'workspaceRevision'].includes(key)) {
                url.searchParams.append(key, value);
            }
        }
        url.hash = startupHash;
        startupLocationClaimed = true;
    }
    url.searchParams.set('workspaceRuntime', runtimeId);
    url.searchParams.set('workspaceActive', '0');
    url.searchParams.set('workspaceRevision', String(globalSettingsRevision));
    return url.href;
}

function createFrameSlot() {
    const id = createWorkspaceId();
    const frame = document.createElement('iframe');
    // The reusable runtime must remain render-active while the shell loader is
    // covering it. Its preparation path restores scroll position on an
    // animation frame, and browsers suspend that callback for hidden iframes.
    frame.className = 'chat-workspace-frame active';
    frame.name = `chat-workspace-${id}`;
    frame.title = 'SillyTavern chat runtime';
    frame.allow = 'autoplay; camera; clipboard-read; clipboard-write; fullscreen; microphone';
    frame.allowFullscreen = true;
    frame.src = getFrameUrl(id);
    framesElement.append(frame);
    return { id, frame };
}

function postToSlot(slot, type, payload = {}) {
    const target = slot?.frame?.contentWindow;
    if (!target) return;
    const message = {
        source: 'sillytavern-chat-workspace-shell',
        type,
        runtimeId: slot.id,
        sessionId: slot.sessionId,
        ...payload,
    };

    let receiver = null;
    try {
        receiver = target[DIRECT_CHILD_RECEIVER];
    } catch {
        // The child may still be loading or navigating; postMessage is safe.
    }
    if (typeof receiver === 'function') {
        receiver(message, globalThis);
        return;
    }
    target.postMessage(message, location.origin);
}

function postToSession(session, type, payload = {}) {
    if (!session) return;
    if (session.id !== runtimeController.activeSessionId) return;
    postToSlot(runtimeController.slot, type, payload);
}

const runtimeController = new WorkspaceRuntimeController({
    createSlot: createFrameSlot,
    assignSlot: (slot, assignment) => {
        slot.frame.title = sessions.find(session => session.id === assignment.sessionId)?.title || 'SillyTavern chat';
        if (slot.appReady) postAssignment(slot, assignment);
    },
    setSlotActive: ({ slot, sessionId }) => {
        // The sole runtime is covered by the shell loader until the target chat,
        // draft, and scroll position have all been restored.
        slot.frame.classList.add('active');
        loaderElement.hidden = true;
        postToSlot(slot, 'active', { active: true });
        rollbackReloadAttempted = false;
        const session = sessions.find(candidate => candidate.id === sessionId);
        if (session) session.unread = false;
        persist();
        if (sessionId === startupSessionId && startupLocationPending) {
            startupLocationPending = false;
            history.replaceState({}, '', location.pathname);
        }
        queueMicrotask(() => {
            broadcastTabsState();
            if (pendingNewChatSessionId === sessionId) {
                pendingNewChatSessionId = null;
                postToSession(session, 'create-new-chat');
            }
        });
    },
});

function postAssignment(slot, { sessionId = slot.targetSessionId, requestId = slot.requestId } = {}) {
    const session = sessions.find(candidate => candidate.id === sessionId);
    if (!session || slot.targetSessionId !== sessionId || slot.requestId !== requestId) return;
    postToSlot(slot, 'assign', {
        // Override postToSlot's committed session identity while this target is
        // still pending. The child must echo the target identity in prepared.
        sessionId,
        requestId,
        identity: session.identity,
        restore: { draft: session.draft, scrollTop: session.scrollTop },
        settingsRevision: globalSettingsRevision,
        personaAvatar: session.personaAvatar || activePersonaAvatar,
        showOwnerUi: ownerUiActivationSessions.has(sessionId),
    });
}

function getTabsState() {
    const activeSession = sessions.find(session => session.id === runtimeController.activeSessionId);
    return {
        sessions: sessions.map(session => ({
            id: session.id,
            title: session.title || session.identity?.chatId || 'Home',
            avatar: session.avatar || '',
            status: session.status,
            canNavigateWhileGenerating: session.canNavigateWhileGenerating,
            saving: session.saving,
            unread: session.unread,
            busy: isSessionBusy(session),
        })),
        activeSessionId: runtimeController.activeSessionId,
        pendingSessionId: runtimeController.pendingSessionId,
        navigationBlocked: isSessionNavigationBlocked(activeSession),
    };
}

function broadcastTabsState() {
    const tabs = getTabsState();
    const slot = runtimeController.slot;
    if (slot?.appReady && slot.sessionId) postToSlot(slot, 'tabs-state', { tabs });
}

function notifyActivationBlocked(reason = 'generating') {
    const slot = runtimeController.slot;
    if (slot?.appReady) postToSlot(slot, 'activation-blocked', { reason });
}

function requestActivation(sessionId, { force = false, recovering = false } = {}) {
    const session = sessions.find(candidate => candidate.id === sessionId);
    if (!session) return { type: 'failed', requestId: null, slot: null };
    const activeSession = sessions.find(candidate => candidate.id === runtimeController.activeSessionId);
    if (!force
        && sessionId !== runtimeController.activeSessionId
        && isSessionNavigationBlocked(activeSession)) {
        notifyActivationBlocked('generating');
        return { type: 'blocked-generating', requestId: null, slot: runtimeController.slot };
    }
    const result = runtimeController.activate(sessionId, { force, recovering });
    if (result.type === 'active') {
        broadcastTabsState();
        return result;
    }
    if (result.type === 'failed') return result;
    broadcastTabsState();
    return result;
}

function applyWorkspaceTheme(theme) {
    document.documentElement.style.setProperty('--workspace-bg', theme.backgroundColor);
    document.documentElement.style.setProperty('--workspace-fg', theme.foregroundColor);
}

function applyChildState(session, state) {
    if (!session || !state || typeof state !== 'object') return;
    const previous = { ...session };
    const nextIdentity = normalizeIdentity(state.identity);
    const duplicate = nextIdentity && sessions.find(candidate => candidate.id !== session.id
        && getIdentityKey(candidate.identity) === getIdentityKey(nextIdentity));
    if (duplicate) {
        requestActivation(duplicate.id);
        return;
    }
    session.identity = nextIdentity;
    session.title = state.title || session.title || nextIdentity?.chatId || 'Home';
    session.avatar = state.avatar ?? session.avatar;
    session.draft = state.draft ?? session.draft;
    session.scrollTop = state.scrollTop || 0;
    session.personaAvatar = state.personaAvatar ?? session.personaAvatar;
    session.status = state.status || SESSION_STATUS.IDLE;
    session.canNavigateWhileGenerating = Boolean(state.canNavigateWhileGenerating);
    session.saving = Boolean(state.saving);
    session.pendingSave = Boolean(state.pendingSave);
    const selectedSessionId = runtimeController.pendingSessionId || runtimeController.activeSessionId;
    if (state.completed && session.id !== selectedSessionId) session.unread = true;
    if (session.id === selectedSessionId && runtimeController.slot) runtimeController.slot.frame.title = session.title;
    if (hasTabPresentationChanged(previous, session)) broadcastTabsState();
    if (hasPersistedSessionChanged(previous, session)) persist();
}

function getInitialPresentation(presentation) {
    return {
        title: presentation?.title || 'Chat',
        avatar: presentation?.avatar || '',
    };
}

function isOpeningBlocked() {
    const activeSession = sessions.find(candidate => candidate.id === runtimeController.activeSessionId);
    const reason = isSessionNavigationBlocked(activeSession) ? 'generating' : runtimeController.pendingSessionId ? 'pending' : null;
    if (!reason) return false;
    notifyActivationBlocked(reason);
    return true;
}

function openSession(identity, presentation, { showOwnerUi = false } = {}) {
    if (isOpeningBlocked()) return null;
    const normalized = normalizeIdentity(identity);
    if (!normalized) return null;
    let session = findSessionByIdentity(sessions, normalized);
    if (!session) {
        session = createWorkspaceSession(normalized, getInitialPresentation(presentation));
        sessions.push(session);
    }
    if (showOwnerUi) ownerUiActivationSessions.add(session.id);
    const activation = requestActivation(session.id);
    if (activation.type === 'active') ownerUiActivationSessions.delete(session.id);
    persist();
    return session;
}

function openNewChat(identity, presentation) {
    if (isOpeningBlocked()) return null;
    const normalized = normalizeIdentity(identity);
    if (!normalized) return null;
    let session = findSessionByIdentity(sessions, normalized);
    if (!session) {
        session = createWorkspaceSession(normalized, getInitialPresentation(presentation));
        sessions.push(session);
    }
    pendingNewChatSessionId = session.id;
    const activation = requestActivation(session.id);
    if (activation?.type === 'active') {
        pendingNewChatSessionId = null;
        queueMicrotask(() => postToSession(session, 'create-new-chat'));
    }
    persist();
    return session;
}

function beginNewChat(session, identity) {
    const normalized = normalizeIdentity(identity);
    if (!session || !normalized || newChatTransitions.has(session.id)
        || getIdentityKey(session.identity) !== getIdentityKey(normalized)) return;
    const index = sessions.indexOf(session);
    const previous = createWorkspaceSession(normalized, {
        title: session.title,
        avatar: session.avatar,
        draft: session.draft,
        scrollTop: session.scrollTop,
        personaAvatar: session.personaAvatar,
    });
    sessions.splice(Math.max(0, index), 0, previous);
    newChatTransitions.set(session.id, { previousSessionId: previous.id, original: { ...session } });
    Object.assign(session, {
        identity: null,
        title: 'New Chat',
        draft: '',
        scrollTop: 0,
        personaAvatar: '',
        status: SESSION_STATUS.IDLE,
        saving: false,
        pendingSave: false,
        unread: false,
    });
    broadcastTabsState();
    persist();
}

function finishNewChat(session, success, state = null) {
    const transition = session && newChatTransitions.get(session.id);
    if (!transition) return;
    if (success) {
        if (state) applyChildState(session, state);
        newChatTransitions.delete(session.id);
        broadcastTabsState();
        persist();
        return;
    }
    const previousIndex = sessions.findIndex(candidate => candidate.id === transition.previousSessionId);
    if (previousIndex >= 0) sessions.splice(previousIndex, 1);
    Object.assign(session, transition.original);
    newChatTransitions.delete(session.id);
    broadcastTabsState();
    persist();
}

function closeSession(sessionId, { discardDraft = false } = {}) {
    const session = sessions.find(candidate => candidate.id === sessionId);
    if (!session || isSessionBusy(session)) return;
    if (session.draft && !discardDraft) {
        const requester = sessions.find(candidate => candidate.id === runtimeController.activeSessionId);
        postToSession(requester, 'confirm-close', {
            targetSessionId: sessionId,
            session: { title: session.title || session.identity?.chatId || 'chat' },
        });
        return;
    }

    const index = sessions.indexOf(session);
    const wasActive = runtimeController.activeSessionId === sessionId;
    sessions.splice(index, 1);
    if (!sessions.length) sessions.push(createWorkspaceSession());
    persist();

    if (wasActive || !runtimeController.activeSessionId) {
        requestActivation(sessions[Math.min(index, sessions.length - 1)].id);
    } else {
        broadcastTabsState();
    }
}

function collapseWorkspaceToActive() {
    if (runtimeController.pendingSessionId) {
        return { accepted: false, reason: 'pending' };
    }

    const result = collapseWorkspaceSessions(sessions, runtimeController.activeSessionId);
    if (!result.accepted) return result;

    sessions.splice(0, sessions.length, ...result.sessions);
    pendingNewChatSessionId = null;
    for (const session of result.removedSessions) newChatTransitions.delete(session.id);
    persist();
    broadcastTabsState();
    return { accepted: true };
}

function receiveWorkspaceChildMessage(message, source, origin) {
    if (origin !== location.origin) return;
    if (!message || message.source !== 'sillytavern-chat-workspace') return;
    const slot = runtimeController.getSlot(message.runtimeId);
    if (!slot || source !== slot.frame.contentWindow) return;

    if (message.type === 'app-ready') {
        runtimeController.markAppReady(slot.id);
        applyWorkspaceTheme(message.theme);
        lastBootStage = 'opening the selected chat';
        setLoaderMessage('Opening chat...');
        armBootTimeout();
        if (slot.targetSessionId && slot.requestId) postAssignment(slot);
        return;
    }
    if (message.type === 'boot-progress') {
        lastBootStage = message.stage || lastBootStage;
        setLoaderMessage(`Initializing: ${lastBootStage}...`);
        armBootTimeout();
        return;
    }
    if (message.type === 'boot-error') {
        clearTimeout(bootTimeout);
        const detail = message.message || 'Unknown initialization error';
        setLoaderMessage(`Startup failed while ${message.stage || lastBootStage}: ${detail}`, { error: true });
        console.error('Chat workspace child failed to initialize', message);
        return;
    }
    if (message.type === 'unloading') {
        runtimeController.markUnloaded(slot.id);
        if (runtimeController.activeSessionId && !runtimeController.pendingSessionId) {
            requestActivation(runtimeController.activeSessionId, { force: true, recovering: true });
        }
        return;
    }
    if (message.type === 'prepared') {
        const session = sessions.find(candidate => candidate.id === message.targetSessionId);
        if (!session || !runtimeController.markPrepared(slot.id, message.requestId, message.targetSessionId)) return;
        ownerUiActivationSessions.delete(message.targetSessionId);
        clearTimeout(bootTimeout);
        applyChildState(session, message.state);
        return;
    }
    if (message.type === 'disable-tabs') {
        if (message.sessionId !== runtimeController.activeSessionId || slot.sessionId !== runtimeController.activeSessionId) return;
        const result = collapseWorkspaceToActive();
        postToSlot(slot, 'tabs-disable-result', {
            requestId: message.requestId,
            accepted: result.accepted,
            reason: result.reason,
        });
        return;
    }
    if (message.type === 'navigation-error') {
        const failure = runtimeController.fail(slot.id, message.requestId, message.targetSessionId);
        if (!failure) return;
        ownerUiActivationSessions.delete(failure.sessionId);
        if (pendingNewChatSessionId === failure.sessionId) pendingNewChatSessionId = null;
        const failedSession = sessions.find(candidate => candidate.id === failure.sessionId);
        if (failedSession && !failure.recovering) failedSession.status = SESSION_STATUS.ERROR;
        console.warn('Could not prepare workspace chat activation', message.message);
        if (!failure.previousSessionId) {
            loaderElement.hidden = true;
            broadcastTabsState();
            return;
        }
        if (!failure.recovering) {
            requestActivation(failure.previousSessionId, { force: true, recovering: true });
            return;
        }
        if (!rollbackReloadAttempted) {
            rollbackReloadAttempted = true;
            runtimeController.markUnloaded(slot.id);
            requestActivation(failure.previousSessionId, { force: true, recovering: true });
            slot.frame.contentWindow.location.reload();
            return;
        }
        loaderElement.hidden = true;
        notifyActivationBlocked('failed');
        broadcastTabsState();
        return;
    }

    const session = sessions.find(candidate => candidate.id === message.sessionId);
    if (!session || session.id !== runtimeController.activeSessionId || slot.sessionId !== session.id) return;
    if (message.type === 'activate-chat') {
        if (message.state) applyChildState(session, message.state);
        requestActivation(message.targetSessionId);
        return;
    }
    if (message.type === 'open-chat') {
        if (message.state) applyChildState(session, message.state);
        openSession(message.identity, message.presentation, { showOwnerUi: message.showOwnerUi });
        return;
    }
    if (message.type === 'open-new-chat') {
        if (message.state) applyChildState(session, message.state);
        openNewChat(message.identity, message.presentation);
        return;
    }
    if (message.type === 'new-chat-starting') {
        beginNewChat(session, message.identity);
        return;
    }
    if (message.type === 'new-chat-finished') {
        finishNewChat(session, message.success, message.state);
        return;
    }
    if (message.type === 'close-chat') {
        if (message.targetSessionId === session.id && message.state) applyChildState(session, message.state);
        closeSession(message.targetSessionId, { discardDraft: message.discardDraft });
        return;
    }
    if (message.type === 'state') {
        applyChildState(session, message.state);
        return;
    }
    if (message.type === 'theme-state') {
        if (session.id === runtimeController.activeSessionId) applyWorkspaceTheme(message.theme);
        return;
    }
    if (message.type === 'persona-changed') {
        if (session.id !== runtimeController.activeSessionId || typeof message.avatar !== 'string') return;
        activePersonaAvatar = message.avatar;
        session.personaAvatar = message.avatar;
        persist();
        return;
    }
    if (message.type === 'extensions-changed') {
        globalSettingsRevision++;
        return;
    }
}

globalThis[DIRECT_SHELL_RECEIVER] = (message, source) => receiveWorkspaceChildMessage(message, source, location.origin);
window.addEventListener('message', event => receiveWorkspaceChildMessage(event.data, event.source, event.origin));

globalThis.addEventListener('pagehide', () => {
    void persistence.flush(getPersistedSnapshot());
});

requestActivation(startupSessionId);
armBootTimeout();
