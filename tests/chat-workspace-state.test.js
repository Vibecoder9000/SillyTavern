import { describe, expect, test } from '@jest/globals';
import {
    SESSION_STATUS,
    createWorkspaceSession,
    createWorkspaceId,
    findSessionByIdentity,
    getAdjacentSessionId,
    getIdentityKey,
    hasPersistedSessionChanged,
    hasTabPresentationChanged,
    isSessionBusy,
    isSessionGenerating,
    isSessionNavigationBlocked,
    normalizeIdentity,
    restoreWorkspace,
    serializeWorkspace,
} from '../public/scripts/chat-workspace-state.js';

const characterChat = { kind: 'character', ownerId: 'alice.png', chatId: 'Chat 1' };
const groupChat = { kind: 'group', ownerId: 0, chatId: 'Group Chat' };

describe('chat workspace state', () => {
    test('creates UUIDs when randomUUID is unavailable on a plain HTTP LAN origin', () => {
        const cryptoApi = {
            getRandomValues(bytes) {
                bytes.fill(17);
                return bytes;
            },
        };

        expect(createWorkspaceId(cryptoApi)).toBe('11111111-1111-4111-9111-111111111111');
    });

    test('normalizes valid identities and rejects incomplete identities', () => {
        expect(normalizeIdentity(groupChat)).toEqual({ kind: 'group', ownerId: '0', chatId: 'Group Chat' });
        expect(normalizeIdentity({ kind: 'character', ownerId: '', chatId: 'Chat 1' })).toBeNull();
        expect(normalizeIdentity({ kind: 'other', ownerId: 'x', chatId: 'y' })).toBeNull();
        expect(getIdentityKey(characterChat)).toBe('character:["alice.png","Chat 1"]');
        expect(getIdentityKey({ kind: 'character', ownerId: 'a:b', chatId: 'c' }))
            .not.toBe(getIdentityKey({ kind: 'character', ownerId: 'a', chatId: 'b:c' }));
    });

    test('finds an exact conversation without conflating an owner\'s chats', () => {
        const first = createWorkspaceSession(characterChat, { id: 'first' });
        const second = createWorkspaceSession({ ...characterChat, chatId: 'Chat 2' }, { id: 'second' });

        expect(findSessionByIdentity([first, second], { ...characterChat })).toBe(first);
        expect(findSessionByIdentity([first, second], { ...characterChat, chatId: 'Chat 2' })).toBe(second);
    });

    test('generation, user-wait, and save states prevent closing', () => {
        const session = createWorkspaceSession(characterChat);
        expect(isSessionBusy(session)).toBe(false);
        session.saving = true;
        expect(isSessionBusy(session)).toBe(true);
        session.saving = false;
        session.pendingSave = true;
        expect(isSessionBusy(session)).toBe(true);
        session.pendingSave = false;
        session.status = SESSION_STATUS.GENERATING;
        expect(isSessionBusy(session)).toBe(true);
        expect(isSessionGenerating(session)).toBe(true);
        session.status = SESSION_STATUS.WAITING;
        expect(isSessionBusy(session)).toBe(true);
        expect(isSessionGenerating(session)).toBe(true);
        session.status = SESSION_STATUS.ERROR;
        expect(isSessionBusy(session)).toBe(false);
        expect(isSessionGenerating(session)).toBe(false);
    });

    test('only detachable generation permits workspace navigation', () => {
        const session = createWorkspaceSession(characterChat);
        session.status = SESSION_STATUS.GENERATING;
        expect(isSessionNavigationBlocked(session)).toBe(true);
        session.canNavigateWhileGenerating = true;
        expect(isSessionNavigationBlocked(session)).toBe(false);
        expect(isSessionBusy(session)).toBe(true);
        session.status = SESSION_STATUS.IDLE;
        expect(isSessionNavigationBlocked(session)).toBe(false);
    });

    test('does not persist runtime-only activity updates', () => {
        const previous = createWorkspaceSession(characterChat, {
            title: 'Alice',
            draft: 'hello',
            scrollTop: 42,
            personaAvatar: 'user.png',
        });
        const active = { ...previous, status: SESSION_STATUS.GENERATING, canNavigateWhileGenerating: true, saving: true };

        expect(hasPersistedSessionChanged(previous, active)).toBe(false);
        expect(hasPersistedSessionChanged(previous, { ...active, draft: 'changed' })).toBe(true);
        expect(hasPersistedSessionChanged(previous, {
            ...active,
            identity: { ...characterChat, chatId: 'Chat 2' },
        })).toBe(true);
    });

    test('persists view state but resets runtime activity after reload', () => {
        const first = createWorkspaceSession(characterChat, {
            id: 'first',
            title: 'Alice',
            draft: 'unfinished draft',
            scrollTop: 123,
            personaAvatar: 'persona.png',
        });
        first.status = SESSION_STATUS.GENERATING;
        const second = createWorkspaceSession(groupChat, { id: 'second', title: 'Party' });

        const saved = serializeWorkspace([first, second], 'second');
        const restored = restoreWorkspace(saved);

        expect(restored.activeSessionId).toBe('second');
        expect(restored.sessions).toHaveLength(2);
        expect(restored.sessions[0]).toMatchObject({
            id: 'first',
            identity: characterChat,
            title: 'Alice',
            draft: 'unfinished draft',
            scrollTop: 123,
            personaAvatar: 'persona.png',
            status: SESSION_STATUS.IDLE,
        });
    });

    test('drops duplicate restored conversations and recovers invalid storage', () => {
        const duplicated = {
            version: 1,
            activeSessionId: 'duplicate',
            tabs: [
                { id: 'first', identity: characterChat },
                { id: 'duplicate', identity: characterChat },
            ],
        };

        const restored = restoreWorkspace(duplicated);
        expect(restored.sessions).toHaveLength(1);
        expect(restored.activeSessionId).toBe('first');

        const fallback = restoreWorkspace({ version: 999, tabs: [] });
        expect(fallback.sessions).toHaveLength(1);
        expect(fallback.activeSessionId).toBe(fallback.sessions[0].id);
    });

    test('does not treat draft and scroll-only changes as tab presentation changes', () => {
        const previous = createWorkspaceSession(characterChat, { title: 'Alice', avatar: 'alice.png' });
        const viewOnlyUpdate = { ...previous, draft: 'new draft', scrollTop: 400 };
        expect(hasTabPresentationChanged(previous, viewOnlyUpdate)).toBe(false);
        expect(hasTabPresentationChanged(previous, { ...viewOnlyUpdate, saving: true })).toBe(true);
        expect(hasTabPresentationChanged(previous, { ...viewOnlyUpdate, unread: true })).toBe(true);
        expect(hasTabPresentationChanged(previous, { ...viewOnlyUpdate, status: SESSION_STATUS.GENERATING })).toBe(true);
        expect(hasTabPresentationChanged(previous, { ...viewOnlyUpdate, canNavigateWhileGenerating: true })).toBe(true);
    });

    test('cycles through chats in either direction and wraps at the ends', () => {
        const sessions = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];

        expect(getAdjacentSessionId(sessions, 'first', 1)).toBe('second');
        expect(getAdjacentSessionId(sessions, 'third', 1)).toBe('first');
        expect(getAdjacentSessionId(sessions, 'first', -1)).toBe('third');
        expect(getAdjacentSessionId(sessions, 'missing', 1)).toBeNull();
        expect(getAdjacentSessionId([sessions[0]], 'first', 1)).toBeNull();
    });

});
