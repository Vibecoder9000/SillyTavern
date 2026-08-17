import {
    Generate,
    characters,
    getCharacterCardFields,
    chat,
    name1,
    addOneMessage,
    saveChatConditional,
    doNewChat,
    clearChat,
    system_avatar,
    updateChatMetadata,
} from '../../script.js';

import {
    getConfig,
    getRoster,
    getState,
    getLocations,
    setCharacterStrings,
    pushCharacterHistory,
    pushCharacterInteraction,
    findRosterIdByName,
} from './state.js';
import { updateRun } from './run-context.js';

// Two characters count as "nearby" when their map coordinates are within this many world
// units of each other (used for scene context when no shared location string applies).
const NEARBY_RADIUS = 30;
const UPDATER_HISTORY_PLAN_ENTRIES = 3;
const UPDATER_HISTORY_LOCATION_CHARS = 48;
const UPDATER_HISTORY_ACTIVITY_CHARS = 96;
const UPDATER_HISTORY_PLAN_CHARS = 120;
const UPDATER_NEARBY_LOCATION_LIMIT = 24;
const SELECTOR_HISTORY_PLAN_ENTRIES = 3;

/**
 * Runs a loud (foreground) generation in the active World Sim host chat so the model's
 * `<tool>` XML renders visibly and executes through ST's tool-calling pipeline (custom
 * XML system — never API function-calling). Execution of the rendered call drives the
 * run via its `action` handler in run-actions.js.
 * @param {string} prompt
 * @returns {Promise<void>}
 */
async function fireWorldSimGeneration(prompt, { disableAutoContinue = false } = {}) {
    // Fresh chat per generation so each selector/updater/initialize step is self-contained
    // and the model isn't paying to re-read the previous step's prompt + tool exchange.
    await doNewChat({ openInWorkspace: false });

    const message = {
        name: name1,
        is_user: true,
        is_system: false,
        mes: prompt,
        send_date: new Date().toLocaleString(),
    };
    chat.push(message);
    addOneMessage(message);
    await saveChatConditional();

    if (disableAutoContinue) {
        await Generate('normal', {
            skipWIAN: true,
            skipPersona: true,
            force_name2: true,
            nativeToolAutoContinue: false,
        });
        return;
    }

    await Generate('normal', {
        skipWIAN: true,
        skipPersona: true,
        force_name2: true,
    });
}

/** Fires the selector step: the model picks focus characters via `select_characters`. */
export async function fireSelector({ snapshot = null, guidance = '', selection = null } = {}) {
    await fireWorldSimGeneration(buildSelectorPrompt(snapshot, guidance, selection));
}

/**
 * Fires the updater step for the given characters via `world_update`.
 * @param {string[]} characterIds
 */
export async function fireUpdater(characterIds, { snapshot = null, guidance = '' } = {}) {
    const config = getConfig();
    const dice = {};
    for (const id of characterIds) dice[id] = Math.floor(Math.random() * config.diceSides) + 1;
    updateRun({ dice });
    await fireWorldSimGeneration(buildUpdaterPrompt(characterIds, dice, snapshot, guidance));
}

function getWorldView(snapshot = null) {
    const liveRoster = getRoster();
    if (!snapshot) return { roster: liveRoster, state: getState(), locations: getLocations() };
    const roster = { ...liveRoster, characters: {} };
    for (const [id, character] of Object.entries(liveRoster.characters || {})) {
        roster.characters[id] = {
            ...character,
            initialized: !!snapshot.characters?.[id]?.initialized,
            history: snapshot.characters?.[id]?.history || { location: [], activity: [], plan: [], summary: [] },
        };
    }
    return { roster, state: snapshot.state || {}, locations: snapshot.locations || { locations: {} } };
}

/**
 * Fires the initialize step for a single character via `world_initialize`.
 * @param {string} avatar
 */
export async function fireInitialize(avatar, extraInstructions = '') {
    await fireWorldSimGeneration(buildInitialCharacterPrompt(avatar, extraInstructions), {
        disableAutoContinue: true,
    });
}

/**
 * Fires the commit step (post-roleplay) via `world_update`.
 * @param {string[]} characterIds
 * @param {string} chatMessages
 * @param {{snapshot?: object|null}} [context]
 */
export async function fireCommit(characterIds, chatMessages, { snapshot = null } = {}) {
    await fireWorldSimGeneration(buildCommitPrompt(characterIds, chatMessages, snapshot));
}

/**
 * Renders the known location regions with their map bounding boxes.
 * @returns {string}
 */
function formatKnownLocations(view = getWorldView()) {
    const locations = view.locations.locations || {};
    const entries = Object.values(locations).filter(hasLocationBounds);
    if (!entries.length) return '';
    let out = 'Known locations (name / description / map edges):\n';
    for (const loc of entries) {
        const desc = loc.description ? ` — ${loc.description}` : '';
        out += `- "${loc.name}"${desc}: left ${round(loc.left)}, bottom ${round(loc.bottom)}, right ${round(loc.right)}, top ${round(loc.top)}\n`;
    }
    return out + '\n';
}

/**
 * Renders the current positions of all initialized characters.
 * @returns {string}
 */
function formatCharacterPositions(view = getWorldView()) {
    const { roster, state } = view;
    const eligible = Object.values(roster.characters).filter(c => c.included && c.initialized);
    if (!eligible.length) return '';

    let out = 'Existing initialized character positions:\n';
    for (const char of eligible) {
        const cur = state.characters[char.id] || {};
        const coord = (Number.isFinite(cur.x) && Number.isFinite(cur.y)) ? `(x: ${round(cur.x)}, y: ${round(cur.y)})` : 'unplaced';
        const summary = cur.summary ? ` - Summary: ${cur.summary}` : '';
        out += `- ${char.name}: ${coord} - ${cur.location || 'unknown location'}${summary}\n`;
    }
    return out + '\n';
}

/**
 * Lists existing characters that a scene transcript may have brought into the event.
 * @param {string[]} initialCharacterIds
 * @returns {string}
 */
function formatSceneCharacterRoster(initialCharacterIds, view = getWorldView()) {
    const { roster, state } = view;
    const initial = new Set(initialCharacterIds);
    const charactersInWorld = Object.values(roster.characters).filter(char => char.included && char.initialized);
    if (!charactersInWorld.length) return '';

    const lines = ['Existing World Sim characters available to include:'];
    for (const char of charactersInWorld) {
        const cur = state.characters[char.id] || {};
        const coord = Number.isFinite(cur.x) && Number.isFinite(cur.y) ? `(${round(cur.x)}, ${round(cur.y)})` : 'unplaced';
        const startedHere = initial.has(char.id) ? ' [scene started with this character]' : '';
        lines.push(`- ${char.name} [id: ${char.id}]${startedHere}`);
        lines.push(`  location: "${cur.location || ''}"; position: ${coord}; activity: "${cur.activity || ''}"; plan: "${cur.plan || ''}"`);
    }
    return lines.join('\n');
}

function round(n) {
    return Math.round(n * 100) / 100;
}

function hasLocationBounds(loc) {
    return loc
        && [loc.left, loc.right, loc.bottom, loc.top].every(Number.isFinite)
        && loc.right > loc.left
        && loc.top > loc.bottom;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipText(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || !Number.isFinite(max) || max <= 0 || value.length <= max) return value;
    return value.slice(0, Math.max(1, max - 3)).trimEnd() + '...';
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameText(a, b) {
    return String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {{ label: string, content: string }[]} sections
 * @returns {string}
 */
export function buildPromptWithMeter(sections) {
    const used = sections
        .map(section => ({
            label: String(section?.label || ''),
            content: String(section?.content || ''),
        }))
        .filter(section => section.content.length > 0);

    const meter = used.map(section => `[${section.label}: ${section.content.length} characters]`).join('\n');
    const body = used.map(section => section.content).join('\n\n');
    return meter ? `${meter}\n\n${body}` : body;
}


/**
 * @returns {{ label: string, content: string }[]}
 */
export function buildSelectorPromptSections(snapshot = null, guidance = '', selection = null) {
    const { roster, state } = getWorldView(snapshot);

    const eligible = Object.values(roster.characters).filter(c => c.included && c.initialized);
    const characterLines = ['Eligible characters:'];
    const historyLines = [];

    for (const char of eligible) {
        const strings = state.characters[char.id] || { location: '', activity: '', plan: '' };
        characterLines.push(`id ${char.id}`);
        if (char.priority) characterLines.push('priority');
        if (strings.location) characterLines.push(strings.location);
        if (strings.activity) characterLines.push(`activity ${strings.activity}`);
        if (strings.plan) characterLines.push(`plan ${strings.plan}`);
        characterLines.push('');

        const history = char.history;
        const candidates = [];
        for (let i = 0; i < history.location.length; i++) {
            const location = String(history.location[i]?.text || '');
            const activity = String(history.activity[i]?.text || '');
            const plan = String(history.plan[i]?.text || '');
            if (!location && !activity && !plan) continue;
            candidates.push({ location, activity, plan });
        }

        const filtered = [];
        let prev = null;
        for (const item of candidates) {
            const duplicateOfPrevious = prev
                && sameText(prev.location, item.location)
                && sameText(prev.activity, item.activity)
                && sameText(prev.plan, item.plan);
            if (!duplicateOfPrevious) filtered.push(item);
            prev = item;
        }

        while (filtered.length && sameText(filtered[filtered.length - 1].location, strings.location)
            && sameText(filtered[filtered.length - 1].activity, strings.activity)
            && sameText(filtered[filtered.length - 1].plan, strings.plan)) {
            filtered.pop();
        }

        const recent = filtered.slice(-SELECTOR_HISTORY_PLAN_ENTRIES);
        if (recent.length > 0) {
            historyLines.push(`id ${char.id}`);
            for (const item of recent) {
                if (item.location) historyLines.push(item.location);
                if (item.activity) historyLines.push(`activity ${item.activity}`);
                if (item.plan) historyLines.push(`plan ${item.plan}`);
                historyLines.push('');
            }
        }
    }

    const sections = [
        { label: 'character info', content: characterLines.join('\n').trim() },
        { label: 'history info', content: historyLines.length ? ['Recent history:', ...historyLines].join('\n') : '' },
        {
            label: 'system instructions',
            content: [
                'Select the next focus character(s) for a world simulation.',
                '',
                'You are choosing who will act next from all included characters. Consider their current location, activity, and plan strings, plus their recent history.',
                '',
                'Instructions:',
                '- Select at least 1 character.',
                '- Select up to 10 characters.',
                '- Return the chosen characters in `characterIds` in the same order you want them updated.',
                '- Base your choice on their plans, recent activity, and natural opportunity.',
                '- Do not force interactions or meetings.',
                '- The world is large; most characters are not involved in any given update.',
                '- Characters with recent long updates are less likely to be selected.',
                '',
                'Use the select_characters tool.',
            ].join('\n'),
        },
    ];
    const requiredIds = Array.isArray(selection?.includedCharacterIds) ? selection.includedCharacterIds : [];
    const excludedIds = Array.isArray(selection?.excludedCharacterIds) ? selection.excludedCharacterIds : [];
    if (requiredIds.length || excludedIds.length) {
        sections.push({
            label: 'character constraints',
            content: [
                requiredIds.length ? `The event must involve these character IDs: ${requiredIds.join(', ')}` : '',
                excludedIds.length ? `The event must not involve these character IDs: ${excludedIds.join(', ')}` : '',
                'Choose any other characters according to the action guidance and world state.',
            ].filter(Boolean).join('\n'),
        });
    }
    if (guidance) sections.push({ label: 'action guidance', content: `Action guidance:\n${guidance}\nChoose the characters who should carry out or be affected by this action.` });
    return sections;
}

/**
 * @returns {string}
 */
export function buildSelectorPrompt(snapshot = null, guidance = '', selection = null) {
    return buildPromptWithMeter(buildSelectorPromptSections(snapshot, guidance, selection));
}

/**
 * @param {string[]} characterIds
 * @param {Record<string, number>} dice
 * @returns {{ label: string, content: string }[]}
 */
export function buildUpdaterPromptSections(characterIds, dice, snapshot = null, guidance = '') {
    const view = getWorldView(snapshot);
    const { roster, state } = view;
    const config = getConfig();

    const characterLines = ['Selected:'];
    const historyLines = [];
    const worldLines = [];

    for (const id of characterIds) {
        const char = roster.characters[id];
        if (!char) continue;
        characterLines.push('<character>');
        characterLines.push(`Name: ${char.name}`);
        characterLines.push(`ID: ${id}`);
        characterLines.push('Card context:');
        characterLines.push(char.cardContext?.text || 'No character context available.');
        characterLines.push('</character>');

        const history = char.history;
        const entries = Math.min(UPDATER_HISTORY_PLAN_ENTRIES, history.location.length);
        if (entries > 0) {
            historyLines.push(`${char.name} recent history (${entries} entries):`);
            for (let i = history.location.length - entries; i < history.location.length; i++) {
                historyLines.push(`- location: "${clipText(history.location[i]?.text, UPDATER_HISTORY_LOCATION_CHARS)}", activity: "${clipText(history.activity[i]?.text, UPDATER_HISTORY_ACTIVITY_CHARS)}", plan: "${clipText(history.plan[i]?.text, UPDATER_HISTORY_PLAN_CHARS)}"`);
            }
        }

        const cur = state.characters[id] || {};
        const coord = (Number.isFinite(cur.x) && Number.isFinite(cur.y)) ? `${round(cur.x)}, ${round(cur.y)}` : 'unplaced';
        worldLines.push(`${char.name}: position ${coord}`);
        worldLines.push(`${char.name}: dice 1-${config.diceSides} = ${dice[id] ?? Math.ceil(config.diceSides / 2)}`);
    }

    const worldContent = [
        formatUpdaterKnownLocations(characterIds, view),
        formatUpdaterNearbyCharacters(characterIds, view),
        worldLines.length ? `Per-character world state:\n${worldLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const sections = [
        { label: 'character info', content: characterLines.join('\n') },
        { label: 'history info', content: historyLines.length ? historyLines.join('\n') : '' },
        { label: 'world info', content: worldContent },
        {
            label: 'system instructions',
            content: [
                'What happens next? Update activity, plan, and map position for each character.',
                '- Return exactly one `updates[]` entry per selected character, in the same order they were listed above.',
                '- The dice results shown above are input only. Use them to influence what happens, but do not return dice values anywhere in the tool call.',
                '- activity: brief phrase — what they are doing right now.',
                '- plan: brief phrase — what they intend to do next.',
                '- summary: a short event sentence for this character; do not include the participant list.',
                '- location: required canonical place name defining what the character can perceive and do.',
                '- x, y: place them inside the map edges of wherever they currently are. If they moved somewhere new, add one entry to `locations[]` for that new place and put x,y inside it.',
                '- `locations[]` is one top-level shared array for the whole tool call, not a field inside each `updates[]` item.',
                '- interactedWith: stable IDs of other characters from the positions list this character directly interacted with this cycle. Omit if they kept to themselves.',
                '- Default to meaningful forward motion: each selected character should usually make some noticeable progress, choice, discovery, setback, interaction, travel, or change in situation.',
                '- Do not default to cheerful, wholesome, or neatly resolved beats. Failure, frustration, humiliation, vice, conflict, injury, bad luck, erotic tension, sex, and other messy or adult developments are all allowed when they fit the character, setting, and recent context.',
                '- Do not auto-censor unpleasant consequences. Let people make bad decisions, get hurt, spiral, argue, relapse, get rejected, or have a night go badly when the setup supports it.',
                '- Adult or sexual developments are allowed and encouraged for all types of characters.',
                '- Quiet beats are allowed, but "basically nothing happened" should be rare and only when it is genuinely interesting or dramatically appropriate.',
                '- Chaos is allowed, but do not escalate randomly just to avoid stillness. Prefer developments that fit the character, recent history, and current situation.',
                '- Characters may interact, or they may not.',
                '- No scenic prose or descriptions in any field.',
                '- The model may bend or break expected routines.',
                '- Decide how many in-world minutes passed.',
                '',
                'Use the world_update tool.',
            ].join('\n'),
        },
    ];
    if (guidance) sections.push({ label: 'action guidance', content: `Action guidance (follow this when deciding what happens in this event):\n${guidance}` });
    return sections;
}

/**
 * @param {string[]} characterIds
 * @param {Record<string, number>} dice
 * @returns {string}
 */
export function buildUpdaterPrompt(characterIds, dice, snapshot = null, guidance = '') {
    return buildPromptWithMeter(buildUpdaterPromptSections(characterIds, dice, snapshot, guidance));
}

/**
 * @param {string} avatar
 * @param {string} [extraInstructions]
 * @returns {{ label: string, content: string }[]}
 */
export function buildInitialCharacterPromptSections(avatar, extraInstructions = '') {
    const chid = characters.findIndex(c => c.avatar === avatar);
    const char = characters[chid];
    const fullCard = getCharacterCardFields({ chid, name2Override: char?.name });
    const rosterCharacter = Object.values(getRoster().characters).find(item => item.avatar === avatar);
    const cardContext = rosterCharacter?.cardContext?.text || [
        `Description: ${fullCard.description}`,
        `Personality: ${fullCard.personality}`,
        `Scenario: ${fullCard.scenario}`,
    ].join('\n');

    const world = [
        formatKnownLocations(),
        formatCharacterPositions(),
    ].filter(Boolean).join('\n');

    const systemInstructions = [
        `This new character is being introduced to the world simulator. This is not a roleplay chat. Use ${char?.name || 'Unknown'} as the actual character name in every card field and generated summary.`,
        '',
        'Character card context:',
        `Name: ${char?.name || 'Unknown'}`,
        cardContext,
        '',
        'Establish the character\'s starting state and create the concrete map locations they need and the outside map. For instance, someone on a beach should have their beach hut, the beach, some of the ocean (as much as the map space allows), and some of the island. The idea is to fill the world with places. Not too much, but not too little.',
        'New locations must extend the existing mapped area unless the related-name character rule below applies. Try to balance the amount of locations in each quadrent and avoid expanding the absolute world size unnecessarily. For example if there\'s 10 items in Q2 and 3 in Q3, place in Q3. Don\'t worry too much about balancing it exactly, approximate is fine. Prioritize the neighbors more.',
        'Normally, place at least one edge of the new location cluster directly against an edge of an existing location.',
        'Do not create a detached island, distant district, fresh map area, or isolated cluster merely because empty coordinates are available. Avoid randomly creating linear lines with seperated groups or following an axis for no good reason.',
        'Being unrelated to existing characters is not a reason to place the character far away. Physical map continuity normally takes priority over thematic separation.',
        'Keep all new nearby and related locations contiguous. Locations may overlap when spatially appropriate. Prioritize closer to 0,0 than farther away. Avoid expanding the map unless there\'s no space.',
        'A single room should generally occupy about 100 square world units.',
        'A city should generally occupy about 1000 square world units.',
        '',
        'Every entry under Current character positions already exists in the simulator.',
        'None of those entries is the character currently being initialized, even if its name, description, or recent events closely match the character card.',
        'Do not duplicate, modify, update, overwrite, or reuse any existing character.',
        '',
        'Before choosing a location, check for an existing character from the same name family.',
        'Names belong to the same name family when their identifying name is the same after ignoring capitalization, punctuation, spacing, titles, unit numbers, model numbers, version labels, parenthetical labels, and descriptive suffixes or prefixes.',
        'Play it by ear. A name contained in another name (like sera and seraphina) may not be the same character. Rely on existing knowledge to detect if it\'s the same character',
        'For example, "Cecile" and "Cecile unit 09" are related names and must be treated as duplicate instances.',
        '"Agnès", "Agnes 2", "Unit Agnès", and "Agnès (alternate)" also belong to the same name family.',
        'Do not require the complete names to match exactly.',
        '',
        'If any existing character belongs to the same name family, the new character must be placed in a separate distant region.',
        'Do not attach the new locations to that character\'s location or to any location in its immediate cluster.',
        'Leave substantial map distance between the two instances so they cannot appear to share a home, room, building, or local area.',
        'The related-name rule overrides the normal map-continuity rule.',
        'A detached distant cluster is required in this case, even if it creates empty map space. This doesn\'t mean you can make a random gap somewhere far away, it still has to be connected to the rest. It just can\'t be near the duplicate character.',
        '',
        'If no related-name character exists, attach the new location cluster directly to the existing map with no empty space between their boundaries.',
        'At least one new location must share part of a horizontal or vertical edge with an existing location.',
        'Corner-only contact does not count as connected.',
        '',
        'Do not introduce any additional characters, including lore characters, the user, or anyone not listed under Current character positions.',
        '',
        'Before calling the tool, state in plain text:',
        '- The new character\'s identifying or base name.',
        '- Whether any existing character belongs to the same name family, including partial and suffixed matches.',
        '- If a related-name character exists, name it and explain how the new character is being placed far from its location cluster.',
        '- If no related-name character exists, identify the existing location whose boundary the new cluster directly touches and confirm that the gap is zero world units.',
        '',
        'Add entries to `locations[]` only for concrete places that need to exist on the map for this character now.',
        'For each location, provide:',
        '- name: a short canonical name that will identify the place in future updates',
        '- description: one sentence describing what kind of place it is',
        '- left, bottom, right, top: the location\'s map boundaries in world units, using multiples of 10',
        'Related new locations must share full or partial boundaries with one another.',
        'If no related-name character exists, at least one new location must also share a full or partial boundary with an existing location.',
        'If a related-name character does exist, the new cluster must instead be detached and substantially distant from that character\'s entire location cluster.',
        '',
        'Return one initialization result with:',
        '- activity: a brief phrase describing what the character is doing now; do not mention the user',
        '- plan: a brief phrase describing what the character intends to do next; do not frame it as interaction with the user or mention anyone else',
        '- summary: one short event sentence describing how the character entered the world or what they just did; do not include a participant list',
        '- x, y: the character\'s exact map coordinates, located inside the boundaries of their starting location',
    ];

    if (extraInstructions) {
        systemInstructions.push('', String(extraInstructions).trim());
    }
    systemInstructions.push('', 'Use the `world_initialize` tool.');

    return [
        {
            label: 'character info',
            content: [
                `This new character is being introduced to the world simulator. Use ${char?.name || 'Unknown'} as the actual character name in every card field and generated summary.`,
                'Character card context:',
                `Name: ${char?.name || 'Unknown'}`,
                cardContext,
            ].join('\n'),
        },
        { label: 'world info', content: world },
        { label: 'system instructions', content: systemInstructions.join('\n') },
    ];
}

/**
 * @param {string} avatar
 * @param {string} [extraInstructions]
 * @returns {string}
 */
export function buildInitialCharacterPrompt(avatar, extraInstructions = '') {
    return buildPromptWithMeter(buildInitialCharacterPromptSections(avatar, extraInstructions));
}

/**
 * @param {string[]} characterIds
 * @param {string} chatMessages
 * @param {object|null} [snapshot]
 * @returns {{ label: string, content: string }[]}
 */
export function buildCommitPromptSections(characterIds, chatMessages, snapshot = null) {
    const view = getWorldView(snapshot);
    const { roster, state } = view;

    const characterLines = ['Characters:'];
    for (const id of characterIds) {
        const strings = state.characters[id] || { location: '', activity: '', plan: '' };
        const char = roster.characters[id];
        const coord = (Number.isFinite(strings.x) && Number.isFinite(strings.y)) ? `(${strings.x}, ${strings.y})` : 'unplaced';
        characterLines.push(`- ${char?.name || id} [id: ${id}]`);
        characterLines.push(`  previous location: "${strings.location}"`);
        characterLines.push(`  previous activity: "${strings.activity}"`);
        characterLines.push(`  previous plan: "${strings.plan}"`);
        characterLines.push(`  previous map coordinates: ${coord}`);
    }

    return [
        { label: 'character info', content: [characterLines.join('\n'), formatSceneCharacterRoster(characterIds, view)].filter(Boolean).join('\n\n') },
        { label: 'history info', content: ['Roleplay transcript:', chatMessages].filter(Boolean).join('\n') },
        {
            label: 'world info',
            content: [
                formatKnownLocations(view),
                formatCharacterPositions(view),
            ].filter(Boolean).join('\n'),
        },
        {
            label: 'system instructions',
            content: [
                'The following roleplay has just occurred. Create the resulting child event by updating every existing World Sim character who was actually involved.',
                '',
                'What are the new activity, plan, and map position for each character after this scene?',
                '- Include every character the scene started with, plus any existing World Sim character who actually entered or participated in the scene.',
                '- Do not add a character merely because they were mentioned, remembered, or discussed.',
                '- Do not invent new characters. Only use stable IDs from the existing-character list.',
                '- Return exactly one `updates[]` entry per involved character and include its `characterId`.',
                '- activity: brief phrase — what they are doing right now.',
                '- plan: brief phrase — what they intend to do next.',
                '- summary: a short event sentence for this character; do not include the participant list.',
                '- location: required canonical place name defining what the character can perceive and do.',
                '- x, y: place them inside the map edges of wherever they ended up. If the scene introduced a new concrete place, add one entry to `locations[]` for it.',
                '- `locations[]` is one top-level shared array for the whole tool call, not a field inside each `updates[]` item.',
                '- Do not return `interactedWith`; scene commits do not record interaction data.',
                '- Preserve the scene\'s real outcome, but prefer updates that leave the characters in a changed or consequential state rather than "nothing really changed."',
                '- Do not sanitize the result into a pleasant or harmless version. Preserve embarrassment, coercive social pressure, lust, violence, injury, intoxication, cruelty, or other mature consequences if they actually happened in the scene.',
                '- Adult or sexual outcomes are allowed and encouraged for all types of characters.',
                '- Do not add random chaos that was not supported by the scene just to make the result feel eventful.',
                'Use the world_update tool.',
            ].join('\n'),
        },
    ];
}

/**
 * @param {string[]} characterIds
 * @param {string} chatMessages
 * @param {object|null} [snapshot]
 * @returns {string}
 */
export function buildCommitPrompt(characterIds, chatMessages, snapshot = null) {
    return buildPromptWithMeter(buildCommitPromptSections(characterIds, chatMessages, snapshot));
}

/**
 * Joins names into a readable list ("A", "A and B", "A, B, and C").
 * @param {string[]} names
 * @returns {string}
 */
function joinNames(names) {
    const list = names.filter(Boolean);
    if (list.length <= 1) return list[0] || '';
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

/**
 * Collects characters relevant to a scene's focal characters: those the focal characters
 * recently interacted with, plus those that are actually nearby (same location string or
 * close map coordinates). Focal characters and uninitialized/excluded characters are skipped.
 * @param {string[]} characterIds
 * @returns {{ id: string, name: string, reasons: string[] }[]}
 */
function collectRelatedCharacters(characterIds, view = getWorldView()) {
    const { roster, state } = view;
    const focal = new Set(characterIds);
    const result = new Map();

    const add = (id, reason) => {
        if (focal.has(id)) return;
        const char = roster.characters[id];
        if (!char || !char.included || !char.initialized) return;
        if (!result.has(id)) result.set(id, { id, name: char.name, reasons: new Set() });
        result.get(id).reasons.add(reason);
    };

    for (const fid of characterIds) {
        const interactions = state.characters?.[fid]?.interactions || [];
        for (const interaction of interactions.slice(-3)) {
            if (interaction?.withId) add(interaction.withId, 'recently interacted');
        }
    }

    for (const fid of characterIds) {
        const f = state.characters[fid] || {};
        for (const [oid, o] of Object.entries(state.characters)) {
            if (focal.has(oid)) continue;
            const sameLoc = f.location && o.location && String(f.location).toLowerCase() === String(o.location).toLowerCase();
            const close = Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(o.x) && Number.isFinite(o.y)
                && Math.hypot(f.x - o.x, f.y - o.y) <= NEARBY_RADIUS;
            if (sameLoc || close) add(oid, 'nearby');
        }
    }

    return [...result.values()].map(r => ({ id: r.id, name: r.name, reasons: [...r.reasons] }));
}

/**
 * Returns location regions relevant to the current updater prompt: the selected characters'
 * present regions, plus regions occupied by nearby/recently-related characters, with a small
 * coordinate fallback for nearby unnamed regions. This keeps the map context local instead
 * of dumping the full world every update.
 * @param {string[]} characterIds
 * @returns {string}
 */
function formatUpdaterKnownLocations(characterIds, view = getWorldView()) {
    const { state } = view;
    const locations = view.locations.locations || {};
    const relevantIds = new Set(characterIds);
    for (const related of collectRelatedCharacters(characterIds, view)) relevantIds.add(related.id);

    const selectedStates = characterIds.map(id => state.characters[id] || {});
    const regionIds = new Set();

    for (const id of relevantIds) {
        const cur = state.characters[id] || {};
        const name = cur.location;
        if (!name) continue;
        const key = String(name).toLowerCase();
        const match = Object.entries(locations).find(([, loc]) => String(loc.name || '').toLowerCase() === key);
        if (match) regionIds.add(match[0]);
    }

    const nearbyRegions = Object.entries(locations)
        .filter(([, loc]) => hasLocationBounds(loc))
        .filter(([, loc]) => selectedStates.some(cur => Number.isFinite(cur.x) && Number.isFinite(cur.y)
            && cur.x >= loc.left - 120 && cur.x <= loc.right + 120
            && cur.y >= loc.bottom - 120 && cur.y <= loc.top + 120))
        .slice(0, UPDATER_NEARBY_LOCATION_LIMIT);

    for (const [id] of nearbyRegions) regionIds.add(id);

    const entries = [...regionIds]
        .map(id => locations[id])
        .filter(hasLocationBounds);

    if (!entries.length) return '';

    let out = 'Relevant known locations (name / description / map edges):\n';
    for (const loc of entries) {
        const desc = loc.description ? ` — ${clipText(loc.description, 120)}` : '';
        out += `- "${loc.name}"${desc}: left ${round(loc.left)}, bottom ${round(loc.bottom)}, right ${round(loc.right)}, top ${round(loc.top)}\n`;
    }
    return out + '\n';
}

/**
 * Lists only nearby or recently-related non-focal characters for updater context.
 * The updater does not need the entire world's roster to decide a local next beat.
 * @param {string[]} characterIds
 * @returns {string}
 */
function formatUpdaterNearbyCharacters(characterIds, view = getWorldView()) {
    const { state } = view;
    const related = collectRelatedCharacters(characterIds, view);
    if (!related.length) return '';

    let out = 'Nearby or recently-related characters:\n';
    for (const entry of related) {
        const cur = state.characters[entry.id] || {};
        const coord = (Number.isFinite(cur.x) && Number.isFinite(cur.y)) ? `(x: ${round(cur.x)}, y: ${round(cur.y)})` : 'unplaced';
        const location = cur.location || 'unknown location';
        const activity = clipText(cur.activity, 100);
        out += `- ${entry.name} [id: ${entry.id}]: ${coord} - ${location}`;
        if (activity) out += ` - ${activity}`;
        if (entry.reasons?.length) out += ` (${entry.reasons.join(', ')})`;
        out += '\n';
    }
    return out + '\n';
}

/**
 * Describes the location regions the focal characters currently occupy, using the
 * registered region descriptions where available.
 * @param {string[]} characterIds
 * @returns {string}
 */
function describeLocales(characterIds, view = getWorldView()) {
    const locs = view.locations.locations || {};
    const seen = new Set();
    const out = [];
    for (const id of characterIds) {
        const name = view.state.characters?.[id]?.location;
        if (!name) continue;
        const key = String(name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const region = Object.values(locs).find(l => String(l.name).toLowerCase() === key);
        out.push(region?.description ? `${region.name}: ${region.description}` : String(name));
    }
    if (!out.length) return '';
    return 'Setting:\n' + out.map(s => `- ${s}`).join('\n');
}

/**
 * Builds the visible opening message for a zoomed-in scene from live world state: each
 * focal character's current location/activity/plan and recent history, the characters that
 * are nearby or recently involved, and the locale descriptions. This grounds the scene in
 * the simulation instead of the (stale) character-card greeting.
 * @param {string[]} characterIds
 * @param {object|null} [snapshot]
 * @returns {string}
 */
export function buildSceneOpening(characterIds, snapshot = null) {
    const view = getWorldView(snapshot);
    const { roster, state } = view;
    const names = characterIds.map(id => roster.characters[id]?.name || id);
    const lines = [];

    lines.push(`<system>\n# Scene: ${joinNames(names)}`, '');

    const locale = describeLocales(characterIds, view);
    if (locale) lines.push(locale, '');

    lines.push('## Current state');
    for (const id of characterIds) {
        const char = roster.characters[id];
        if (!char) continue;
        const cur = state.characters?.[id] || {};
        lines.push(char.name);
        if (cur.location) lines.push(`  Location: ${cur.location}`);
        if (cur.activity) lines.push(`  Now: ${cur.activity}`);
        if (cur.plan) lines.push(`  Intends to: ${cur.plan}`);
        if (cur.summary) lines.push(`  Status: ${cur.summary}`);
        const recent = (char.history?.activity || [])
            .slice(-3).map(h => h?.text).filter(Boolean);
        if (recent.length) lines.push(`  Recent history: ${recent.join(' → ')}`);
        lines.push('');
    }

    const related = collectRelatedCharacters(characterIds, view);
    if (related.length) {
        lines.push('## Nearby / recently involved');
        for (const r of related) {
            const cur = state.characters?.[r.id] || {};
            const at = cur.location ? ` — at ${cur.location}` : '';
            const doing = cur.activity ? `, ${cur.activity}` : '';
            lines.push(`- ${r.name} (${r.reasons.join(', ')})${at}${doing}`);
        }
        lines.push('');
    }

    lines.push(
        '## Instructions',
        `This is a zoomed-in scene from a world simulation, focused on ${joinNames(names)}. The state above is the ground truth — stay consistent with it.`,
        `Play ${joinNames(names)} from this moment, picking up from what they are currently doing. Play it out beat by beat; do not skip ahead, summarize, or wrap the scene up on your own. Write description in plain text and speech in quotes.`,
        // The first turn is a "what's going on here" snapshot, nothing more. The user is NOT a
        // character in this world — they have no state and are not present in the scene. Their
        // name may appear in a focal character's history or memories (they interacted before),
        // but that is not a cue to bring them into the room. The failure mode this prevents:
        // having a character turn to / address / question the user, which silently forces the
        // user to reply as speech. The opening must leave the user free to enter however they
        // choose (or not at all).
        `This opening turn only sets the scene: render the current state above as prose — establish where ${joinNames(names)} are, what they are doing, and the mood of the moment. ${name1} is not present and is not a participant; if ${name1}'s name appears in a character's history or memory, treat it only as backstory, not as someone in the scene. Do not address ${name1}, ask ${name1} anything, have any character speak to or turn toward ${name1}, or otherwise assume ${name1} will respond. End on the situation as it stands.`,
        `From the next turn on, follow ${name1}'s lead. ${name1} may respond in any form: scene description or narration for you to take up and continue, speech directed at the character(s) for them to react to, a simple "continue scene" (or similar) to just keep playing the moment forward, or anything else. Respond in character to whatever they give you, and do not require any one of these forms.`,
        `Write out the current state in prose. Begin.\n</system>`,
    );

    return lines.join('\n').trim();
}

/**
 * Builds a concise, current scenario line from world state, used to OVERRIDE the members'
 * (stale) card scenario for the scene chat. ST falls back to card scenarios only when the
 * chat_metadata scenario override is empty, so a non-empty current scenario suppresses them.
 * @param {string[]} characterIds
 * @param {object|null} [snapshot]
 * @returns {string}
 */
export function buildSceneScenario(characterIds, snapshot = null) {
    const view = getWorldView(snapshot);
    const { roster, state } = view;
    const parts = [];
    for (const id of characterIds) {
        const char = roster.characters[id];
        if (!char) continue;
        const cur = state.characters?.[id] || {};
        const bits = [cur.location && `at ${cur.location}`, cur.activity].filter(Boolean).join(', ');
        parts.push(bits ? `${char.name} is ${bits}.` : `${char.name} is present.`);
    }
    return parts.join(' ');
}

/**
 * Seeds a freshly-opened scene group chat: drops the auto-seeded card greetings, overrides
 * the stale card scenario with the current world state, posts a world-state opening message,
 * and auto-fires the first group generation. Must run with the scene group already selected.
 * @param {string[]} characterIds
 * @param {object|null} [snapshot]
 * @returns {Promise<void>}
 */
export async function seedSceneOpening(characterIds, snapshot = null) {
    const roster = getRoster();
    const names = characterIds.map(id => roster.characters[id]?.name || id);
    console.log('[world-sim] Zooming in on current state:', names.join(', '));

    // Replace the auto-seeded card greeting(s) with our world-state opening.
    console.log('[world-sim] Clearing card greeting and seeding world-state opening.');
    await clearChat({ clearData: true });

    // Suppress the stale per-card scenario by overriding it with the current situation.
    const scenario = buildSceneScenario(characterIds, snapshot);
    console.log('[world-sim] Overriding scene scenario:', scenario);
    updateChatMetadata({ scenario }, false);

    const message = {
        name: 'World Sim',
        is_user: false,
        is_system: false,
        force_avatar: system_avatar,
        mes: buildSceneOpening(characterIds, snapshot),
        send_date: new Date().toLocaleString(),
        extra: {},
    };
    chat.push(message);
    addOneMessage(message);
    await saveChatConditional();
    console.log('[world-sim] Opening message posted; triggering start of the scene generation.');

    // Auto-generate the opening turn. With a group selected, Generate routes to the group
    // wrapper; the focal names in the opening message activate those members to respond.
    Generate('normal')
        .then(() => console.log('[world-sim] Scene opening generation finished.'))
        .catch(err => console.error('[world-sim] Scene opening generation failed:', err));
}

/**
 * @param {object} updateArgs
 */
export function applyWorldUpdate(updateArgs) {
    const updates = Array.isArray(updateArgs.updates) ? updateArgs.updates : [];

    for (const update of updates) {
        const id = update.characterId;
        if (!id) continue;
        const activity = String(update.activity || '');
        const plan = String(update.plan || '');
        const summary = String(update.summary || '');
        const coords = {};
        if (Number.isFinite(Number(update.x))) coords.x = Number(update.x);
        if (Number.isFinite(Number(update.y))) coords.y = Number(update.y);
        const location = String(update.location || '');
        setCharacterStrings(id, { location, activity, plan, summary, ...coords });
        pushCharacterHistory(id, 'location', location);
        pushCharacterHistory(id, 'activity', activity);
        pushCharacterHistory(id, 'plan', plan);
        pushCharacterHistory(id, 'summary', summary);

        // Record interactions symmetrically so either participant's scene context can surface
        // the other as "recently interacted". Partner names are resolved to roster ids.
        const partners = Array.isArray(update.interactedWith) ? update.interactedWith : [];
        for (const partnerName of partners) {
            const partnerId = getRoster().characters?.[String(partnerName)] ? String(partnerName) : findRosterIdByName(partnerName);
            if (!partnerId || partnerId === id) continue;
            pushCharacterInteraction(id, partnerId, summary);
            pushCharacterInteraction(partnerId, id, summary);
        }
    }
}
