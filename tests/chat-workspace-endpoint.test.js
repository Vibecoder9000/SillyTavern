import { describe, expect, test } from '@jest/globals';
import {
    CHAT_WORKSPACE_VERSION,
    MAX_WORKSPACE_TABS,
    getChatWorkspaceRootDocument,
    validateWorkspaceState,
} from '../src/endpoints/chat-workspace.js';

describe('chat workspace endpoint state validation', () => {
    test('serves the shell at the visible root and the app document to internal runtimes', () => {
        expect(getChatWorkspaceRootDocument({ query: {} })).toBe('chat-workspace.html');
        expect(getChatWorkspaceRootDocument({ query: { source: 'openrouter' } })).toBe('chat-workspace.html');
        expect(getChatWorkspaceRootDocument({ query: { workspaceRuntime: 'runtime-1' } })).toBe('index.html');
    });

    test('accepts serialized workspace state', () => {
        const workspace = { version: CHAT_WORKSPACE_VERSION, activeSessionId: 'one', tabs: [{ id: 'one' }] };
        expect(validateWorkspaceState(workspace)).toBe(workspace);
    });

    test('rejects malformed or oversized workspace state', () => {
        expect(validateWorkspaceState(null)).toBeNull();
        expect(validateWorkspaceState({ version: 999, tabs: [] })).toBeNull();
        expect(validateWorkspaceState({ version: CHAT_WORKSPACE_VERSION, tabs: Array(MAX_WORKSPACE_TABS + 1) })).toBeNull();
    });
});
