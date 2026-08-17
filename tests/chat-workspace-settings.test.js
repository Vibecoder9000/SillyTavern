import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const appScript = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const bridgeScript = readFileSync(new URL('../public/scripts/chat-workspace-bridge.js', import.meta.url), 'utf8');
const shellScript = readFileSync(new URL('../public/scripts/chat-workspace.js', import.meta.url), 'utf8');
const koboldSettingsScript = readFileSync(new URL('../public/scripts/kai-settings.js', import.meta.url), 'utf8');
const novelSettingsScript = readFileSync(new URL('../public/scripts/nai-settings.js', import.meta.url), 'utf8');
const openAiSettingsScript = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');

describe('chat workspace global settings synchronization', () => {
    test('keeps settings local to the sole runtime and updates the workspace cache after saves', () => {
        expect(appScript).toContain('setWorkspaceCachedValue(WORKSPACE_CACHE_KEYS.SETTINGS, workspaceSettingsResponse);');
        expect(appScript).not.toContain('notifyWorkspaceSettingsSnapshot');
        expect(appScript).not.toContain('applyWorkspaceSettingsSnapshot');
    });

    test('does not contain cross-runtime settings snapshot messages', () => {
        expect(bridgeScript).not.toContain("post('settings-snapshot'");
        expect(bridgeScript).not.toContain("post('settings-applied'");
        expect(shellScript).not.toContain("message.type === 'settings-snapshot'");
        expect(shellScript).not.toContain("message.type === 'settings-applied'");
    });

    test('does not mutate the cached settings response while parsing presets', () => {
        expect(koboldSettingsScript).toContain('data.koboldai_settings.map(item => JSON.parse(item))');
        expect(novelSettingsScript).toContain('data.novelai_settings.map(item => JSON.parse(item))');
        expect(openAiSettingsScript).toContain('data.openai_settings.map(item => JSON.parse(item))');
    });

    test('completes successful new-chat transitions with the final state', () => {
        expect(bridgeScript).toContain('state: success ? bridgeApi.getState() : null');
        expect(shellScript).toContain('newChatTransitions.delete(session.id);');
        expect(shellScript).toContain('finishNewChat(session, message.success, message.state);');
    });
});
