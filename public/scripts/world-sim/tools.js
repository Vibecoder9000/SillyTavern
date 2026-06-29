import { ToolManager } from '../tool-calling.js';
import { eventSource, event_types } from '../../script.js';

const SELECT_CHARACTERS = 'select_characters';
const WORLD_INITIALIZE = 'world_initialize';
const WORLD_UPDATE = 'world_update';
const ALL_WORLD_SIM_TOOL_NAMES = [SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE];

/**
 * Single source of truth for the active world-sim tool scope: a Set of allowed tool names
 * while a run is in progress, or null when no run is active (all world-sim tools stay hidden).
 * Each world-sim tool's shouldRegister reads this, so visibility stays correct no matter how
 * often ST recreates the tool objects (registerNativeToolCommand → #tools.clear()).
 */
let activeScope = null;

/** Builds a shouldRegister closure reflecting live scope state for one world-sim tool. */
function makeShouldRegister(name) {
    return () => activeScope?.has(name) ?? false;
}

/**
 * Registers (or re-registers) the world-sim tools. ST's `registerNativeToolCommand` does
 * `#tools.clear()` before re-registering builtins, which silently wipes our tools. We
 * therefore call this each time before a generation rather than relying on the one-time
 * init. Overwriting is safe — ST warns in the console but the new definition takes effect.
 */
export function registerWorldSimTools() {
    const newlyRegistered = !ToolManager.tools.some(t => t.name === WORLD_INITIALIZE);

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
        shouldRegister: makeShouldRegister(SELECT_CHARACTERS),
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
        shouldRegister: makeShouldRegister(WORLD_INITIALIZE),
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
        shouldRegister: makeShouldRegister(WORLD_UPDATE),
        stealth: false,
        forceContinue: false,
    });

    if (newlyRegistered) {
        console.log('[world-sim] Registered tools:', ALL_WORLD_SIM_TOOL_NAMES.join(', '));
    }
}

/**
 * Activates the world-sim tool scope for the current run: only `allowedToolNames` are exposed
 * to the model (every other tool is hidden via the native-tool allowlist), and the world-sim
 * tools become visible because their shouldRegister reads `activeScope`. The scope persists
 * until explicitly cleared, so reroll/correction turns keep the same whitelist.
 * @param {string[]|null} [allowedToolNames]
 */
export function activateWorldSimToolScope(allowedToolNames = null) {
    const names = allowedToolNames?.length ? allowedToolNames : ALL_WORLD_SIM_TOOL_NAMES;
    activeScope = new Set(names);
    registerWorldSimTools();
    ToolManager.setNativeToolAllowlist(names);
    console.log('[world-sim] Tool scope active:', names.join(', '));
}

/**
 * Clears the world-sim tool scope. World-sim tools immediately report shouldRegister() === false
 * (activeScope is null), and the allowlist is removed so normal tools return.
 */
export function clearWorldSimToolScope() {
    if (!activeScope) return;
    activeScope = null;
    ToolManager.clearNativeToolAllowlist();
    console.log('[world-sim] Tool scope cleared.');
}

// ST clears the tool registry (registerNativeToolCommand → #tools.clear()) on settings/MCP/
// chat changes — including the CHAT_CHANGED that fires during a run's doNewChat(). If a scope
// is active, re-register the world-sim tools and re-assert the allowlist before the prompt is
// built. GENERATION_STARTED fires before the tool prompt is assembled within Generate().
eventSource.on(event_types.GENERATION_STARTED, () => {
    if (!activeScope) return;
    registerWorldSimTools();
    ToolManager.setNativeToolAllowlist([...activeScope]);
});

export { SELECT_CHARACTERS, WORLD_INITIALIZE, WORLD_UPDATE };
