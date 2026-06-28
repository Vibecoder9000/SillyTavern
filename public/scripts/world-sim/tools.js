import { ToolManager } from '../tool-calling.js';

const SELECT_CHARACTERS = 'select_characters';
const WORLD_INITIALIZE = 'world_initialize';
const WORLD_UPDATE = 'world_update';
let clearActiveWorldSimToolScope = null;

/**
 * Registers (or re-registers) the world-sim tools. ST's `registerNativeToolCommand` does
 * `#tools.clear()` before re-registering builtins, which silently wipes our tools. We
 * therefore call this each time before a generation rather than relying on the one-time
 * init. Overwriting is safe — ST warns in the console but the new definition takes effect.
 */
export function registerWorldSimTools() {

    ToolManager.registerFunctionTool({
        name: SELECT_CHARACTERS,
        displayName: 'Select Characters',
        description: 'Select characters to focus on next.',
        parameters: {
            type: 'object',
            properties: {
                characterIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'IDs of selected characters.',
                },
            },
            required: ['characterIds'],
        },
        action: async (args) => {
            const { onSelectCharacters } = await import('./run-actions.js');
            return onSelectCharacters(args);
        },
        formatMessage: (args) => `Selected characters: ${args.characterIds?.join(', ') || 'none'}`,
        shouldRegister: () => false,
        stealth: false,
        forceContinue: false,
    });

    ToolManager.registerFunctionTool({
        name: WORLD_INITIALIZE,
        displayName: 'World Initialize',
        description: 'Apply the starting world-state for the single character being initialized by the simulator.',
        parameters: {
            type: 'object',
            properties: {
                activity: { type: 'string' },
                plan: { type: 'string' },
                summary: { type: 'string' },
                x: { type: 'number', description: 'Map X coordinate where the character currently is. Place inside the bounding box of their starting location region.' },
                y: { type: 'number', description: 'Map Y coordinate where the character currently is. Place inside the bounding box of their starting location region.' },
                locations: {
                    type: 'array',
                    description: 'Named world-map regions to register only when the character needs a new concrete place that is not already in the known-locations list.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Short canonical name used to identify this location in future updates.' },
                            description: { type: 'string', description: 'One sentence describing what kind of place this is.' },
                            left: { type: 'number', description: 'Left edge.' },
                            bottom: { type: 'number', description: 'Bottom edge.' },
                            right: { type: 'number', description: 'Right edge.' },
                            top: { type: 'number', description: 'Top edge.' },
                        },
                        required: ['name', 'description', 'left', 'bottom', 'right', 'top'],
                    },
                },
            },
            required: ['activity', 'plan', 'summary', 'x', 'y'],
        },
        action: async (args) => {
            const { onWorldInitialize } = await import('./run-actions.js');
            return onWorldInitialize(args);
        },
        formatMessage: () => 'Initialized 1 character',
        shouldRegister: () => false,
        stealth: false,
        forceContinue: false,
    });

    ToolManager.registerFunctionTool({
        name: WORLD_UPDATE,
        displayName: 'World Update',
        description: 'Apply world-state updates to the character or characters already selected by the simulator.',
        parameters: {
            type: 'object',
            properties: {
                updates: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            activity: { type: 'string' },
                            plan: { type: 'string' },
                            summary: { type: 'string' },
                            x: { type: 'number', description: 'Map X coordinate where the character currently is. Place inside the bounding box of their current location region.' },
                            y: { type: 'number', description: 'Map Y coordinate where the character currently is. Place inside the bounding box of their current location region.' },
                            interactedWith: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Names of other existing characters this character directly interacted with this cycle (talked to, met, traveled with, fought, etc). Use exact names from the character positions list. Omit or leave empty if none.',
                            },
                        },
                        required: ['activity', 'plan', 'summary', 'x', 'y'],
                    },
                },
                globalMinutesPassed: {
                    type: 'integer',
                    description: 'Total in-world minutes that passed this cycle. Only provide this for normal tick updates.',
                },
                locations: {
                    type: 'array',
                    description: 'Named world-map regions to register only when a selected character needs a new concrete place that is not already in the known-locations list.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Short canonical name used to identify this location in future updates.' },
                            description: { type: 'string', description: 'One sentence describing what kind of place this is.' },
                            left: { type: 'number', description: 'Left edge.' },
                            bottom: { type: 'number', description: 'Bottom edge.' },
                            right: { type: 'number', description: 'Right edge.' },
                            top: { type: 'number', description: 'Top edge.' },
                        },
                        required: ['name', 'description', 'left', 'bottom', 'right', 'top'],
                    },
                },
            },
            required: ['updates'],
        },
        action: async (args) => {
            const { onWorldUpdate } = await import('./run-actions.js');
            return onWorldUpdate(args);
        },
        formatMessage: (args) => `World update: ${args.updates?.length || 0} character(s)`,
        shouldRegister: () => false,
        stealth: false,
        forceContinue: false,
    });
}

function applyWorldSimToolScope(allowedToolNames = null) {
    // Re-register in case ST's #tools.clear() was called since the last init.
    registerWorldSimTools();

    const allowedNames = allowedToolNames?.length ? allowedToolNames : [SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE];

    // Snapshot shouldRegister for every tool, then silence non-world-sim tools.
    const worldSimNames = new Set(allowedNames);
    const snapshots = ToolManager.tools.map(tool => ({ tool, prev: tool.shouldRegister }));
    for (const { tool } of snapshots) {
        tool.shouldRegister = worldSimNames.has(tool.name) ? () => true : () => false;
    }
    ToolManager.setNativeToolAllowlist(allowedNames);

    return () => {
        for (const { tool, prev } of snapshots) {
            tool.shouldRegister = prev;
        }
        ToolManager.clearNativeToolAllowlist();
    };
}

/**
 * Activates the World Sim native-tool scope for the current run. The scope persists until
 * explicitly cleared so manual retry/correction turns keep the same whitelist.
 * @param {string[]|null} [allowedToolNames]
 */
export function activateWorldSimToolScope(allowedToolNames = null) {
    clearWorldSimToolScope();
    clearActiveWorldSimToolScope = applyWorldSimToolScope(allowedToolNames);
}

/**
 * Clears any active World Sim native-tool scope and restores the prior registrations.
 */
export function clearWorldSimToolScope() {
    if (!clearActiveWorldSimToolScope) {
        return;
    }

    const cleanup = clearActiveWorldSimToolScope;
    clearActiveWorldSimToolScope = null;
    cleanup();
}

export { SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE };
