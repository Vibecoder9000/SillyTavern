const WORKSPACE_VERSION = 1;

export const SESSION_STATUS = Object.freeze({
    IDLE: 'idle',
    GENERATING: 'generating',
    WAITING: 'waiting',
    ERROR: 'error',
});

/**
 * Creates an opaque workspace identifier in secure and non-secure contexts.
 * `crypto.randomUUID()` is unavailable on plain HTTP LAN origins in Firefox,
 * even though `crypto.getRandomValues()` remains available.
 * @param {Crypto|undefined} [cryptoApi=globalThis.crypto]
 * @returns {string}
 */
export function createWorkspaceId(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();

    const bytes = new Uint8Array(16);
    if (typeof cryptoApi?.getRandomValues === 'function') {
        cryptoApi.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWorkspaceSession(identity = null, seed = {}) {
    return {
        id: seed.id || createWorkspaceId(),
        identity: normalizeIdentity(identity),
        title: String(seed.title || 'Home'),
        avatar: String(seed.avatar || ''),
        draft: String(seed.draft || ''),
        scrollTop: Number(seed.scrollTop) || 0,
        personaAvatar: typeof seed.personaAvatar === 'string' ? seed.personaAvatar : '',
        status: SESSION_STATUS.IDLE,
        saving: false,
        pendingSave: false,
        unread: false,
    };
}

export function normalizeIdentity(identity) {
    if (!identity || !['character', 'group'].includes(identity.kind)) return null;
    const ownerId = String(identity.ownerId ?? '');
    const chatId = String(identity.chatId ?? '');
    if (!ownerId || !chatId) return null;
    return { kind: identity.kind, ownerId, chatId };
}

export function getIdentityKey(identity) {
    const normalized = normalizeIdentity(identity);
    return normalized ? `${normalized.kind}:${JSON.stringify([normalized.ownerId, normalized.chatId])}` : null;
}

export function isSessionBusy(session) {
    return session.saving
        || session.pendingSave
        || session.status === SESSION_STATUS.GENERATING
        || session.status === SESSION_STATUS.WAITING;
}

export function isSessionGenerating(session) {
    return session?.status === SESSION_STATUS.GENERATING
        || session?.status === SESSION_STATUS.WAITING;
}

export function findSessionByIdentity(sessions, identity) {
    const key = getIdentityKey(identity);
    return key ? sessions.find(session => getIdentityKey(session.identity) === key) ?? null : null;
}

/**
 * Gets the neighboring workspace session, wrapping at either end.
 * @param {Array<{id: string}>} sessions Ordered workspace sessions
 * @param {string} currentSessionId Session to move from
 * @param {-1|1} direction Navigation direction
 * @returns {string|null} Neighboring session ID
 */
export function getAdjacentSessionId(sessions, currentSessionId, direction) {
    if (sessions.length < 2) return null;
    const currentIndex = sessions.findIndex(session => session.id === currentSessionId);
    if (currentIndex < 0) return null;
    return sessions[(currentIndex + direction + sessions.length) % sessions.length].id;
}

export function hasTabPresentationChanged(previous, next) {
    return previous.title !== next.title
        || previous.avatar !== next.avatar
        || previous.status !== next.status
        || previous.saving !== next.saving
        || previous.pendingSave !== next.pendingSave
        || previous.unread !== next.unread;
}

/**
 * Returns whether a child update changed anything included in the persisted
 * workspace snapshot. Runtime-only activity (generation and chat-save status)
 * must not trigger an account workspace write.
 */
export function hasPersistedSessionChanged(previous, next) {
    return getIdentityKey(previous.identity) !== getIdentityKey(next.identity)
        || previous.title !== next.title
        || previous.avatar !== next.avatar
        || previous.draft !== next.draft
        || previous.scrollTop !== next.scrollTop
        || previous.personaAvatar !== next.personaAvatar;
}

export function serializeWorkspace(sessions, activeSessionId) {
    return {
        version: WORKSPACE_VERSION,
        activeSessionId: sessions.some(session => session.id === activeSessionId) ? activeSessionId : sessions[0]?.id ?? null,
        tabs: sessions.map(session => ({
            id: session.id,
            identity: normalizeIdentity(session.identity),
            title: session.title,
            avatar: session.avatar,
            draft: session.draft,
            scrollTop: session.scrollTop,
            personaAvatar: session.personaAvatar,
        })),
    };
}

export function restoreWorkspace(value) {
    if (!value || value.version !== WORKSPACE_VERSION || !Array.isArray(value.tabs)) {
        const session = createWorkspaceSession();
        return { sessions: [session], activeSessionId: session.id };
    }

    const usedIds = new Set();
    const usedIdentities = new Set();
    const sessions = [];
    for (const tab of value.tabs) {
        const session = createWorkspaceSession(tab.identity, tab);
        const identityKey = getIdentityKey(session.identity);
        if (usedIds.has(session.id) || (identityKey && usedIdentities.has(identityKey))) continue;
        usedIds.add(session.id);
        identityKey && usedIdentities.add(identityKey);
        sessions.push(session);
    }

    if (!sessions.length) sessions.push(createWorkspaceSession());
    const activeSessionId = sessions.some(session => session.id === value.activeSessionId)
        ? value.activeSessionId
        : sessions[0].id;
    return { sessions, activeSessionId };
}
