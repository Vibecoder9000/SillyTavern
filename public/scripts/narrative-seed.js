import {
    chat,
    extension_prompt_roles,
    extension_prompt_types,
    getOverswipeBehavior,
    isSwipingAllowed,
    saveSettingsDebounced,
    setExtensionPrompt,
    stopGeneration,
    swipe,
} from '../script.js';
import { OVERSWIPE_BEHAVIOR, SWIPE_DIRECTION } from './constants.js';
import { t } from './i18n.js';
import {
    buildNarrativeSeed,
    combineNarrativeSeed,
    DEFAULT_NARRATIVE_SEED_TEMPLATE,
    formatNarrativeSeedPrompt,
    getSeedChunk,
    isValidNarrativeSeed,
} from './narrative-seed-core.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user } from './power-user.js';
import { CONNECT_API_MAP } from './slash-commands.js';

/** @typedef {import('./narrative-seed-core.js').NarrativeSeed} NarrativeSeed */

const PROMPT_KEY = 'narrative_seed';
const DRAFT_COUNT = 3;
const DRAFT_INSTRUCTION = 'Write a short continuation of this scene as plain narration. Make something happen. Output only the story text.';

/**
 * The seed used by the current generation. It outlives prompt assembly because
 * saveReply stamps it on the reply and tool follow-ups inject it again.
 * @type {NarrativeSeed|null}
 */
let activeSeed = null;

/**
 * What the next swipe generation should do, set by the Seed block buttons.
 * @type {{mode: 'reuse', seed: NarrativeSeed}|{mode: 'draw'}|null}
 */
let nextAction = null;

/**
 * Unapplied picker state per open block.
 * @type {WeakMap<HTMLElement, {seed: NarrativeSeed, selection: number[], tab: string}>}
 */
const pickerStates = new WeakMap();

/**
 * Removes the seed from the prompt. Generate calls this as soon as the prompt is
 * built, so the seed can't leak into later generations or token counts.
 */
export function clearNarrativeSeedPrompt() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

/**
 * @param {NarrativeSeed} seed Seed to inject
 */
function injectSeed(seed) {
    const combined = combineNarrativeSeed(seed);
    if (!combined) {
        return;
    }
    const prompt = formatNarrativeSeedPrompt(power_user.narrative_seed.template || DEFAULT_NARRATIVE_SEED_TEMPLATE, combined);
    setExtensionPrompt(PROMPT_KEY, prompt, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

/**
 * Writes the current generation's seed to a reply's extra, or removes the field.
 * A new swipe inherits the previous swipe's extra, so it must always be overwritten.
 * @param {object} extra Message extra
 */
export function applyNarrativeSeedToExtra(extra) {
    if (activeSeed) {
        extra.narrative_seed = structuredClone(activeSeed);
    } else {
        delete extra.narrative_seed;
    }
}

/**
 * Builds the context for the seed source from the chat Generate already prepared.
 * @param {object[]} coreChat Chat messages prepared for the prompt
 * @param {number} contextMessages How many recent messages to include
 * @returns {{role: string, content: string}[]} Prompt messages
 */
function buildDraftMessages(coreChat, contextMessages) {
    const recent = coreChat
        .filter(message => !message.is_system && !message.extra?.is_tool_result && message.mes)
        .slice(-Math.max(1, contextMessages));
    const history = recent.map(message => ({
        role: message.is_user ? 'user' : 'assistant',
        content: `${message.name}: ${message.mes}`,
    }));
    return [...history, { role: 'user', content: DRAFT_INSTRUCTION }];
}

/**
 * Requests one draft from the seed source. This goes straight to the connection
 * profile: it doesn't touch the main connection, the lorebook or the chat.
 * @param {string} profileId Connection profile ID
 * @param {{role: string, content: string}[]} messages Prompt messages
 * @param {AbortSignal} signal Abort signal
 * @returns {Promise<string>} Draft text
 */
async function requestDraft(profileId, messages, signal) {
    const { ConnectionManagerRequestService } = await import('./extensions/shared.js');
    const { temperature, max_tokens } = power_user.narrative_seed;
    const profile = ConnectionManagerRequestService.getProfile(profileId);
    const overrides = { temperature };
    if (CONNECT_API_MAP[profile.api]?.selected === 'textgenerationwebui') {
        // Text Completion presets set the limit under all of these names.
        Object.assign(overrides, { max_tokens, max_new_tokens: max_tokens, n_predict: max_tokens, num_predict: max_tokens });
    }
    const result = await ConnectionManagerRequestService.sendRequest(profileId, messages, max_tokens, { stream: false, signal }, overrides);
    return typeof result?.content === 'string' ? result.content : '';
}

/**
 * Draws a new seed. A failed or late draft is simply missing from the result.
 * @param {object[]} coreChat Chat messages prepared for the prompt
 * @param {AbortSignal} signal Stops the requests when generation is stopped
 * @returns {Promise<NarrativeSeed|null>} The seed, or null if no draft arrived
 */
async function drawSeed(coreChat, signal) {
    const settings = power_user.narrative_seed;
    if (!settings.source_profile) {
        toastr.warning(t`Choose a seed source in the Seed settings. Continuing without a seed.`, t`Seed`);
        return null;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, Math.max(1, settings.timeout_seconds) * 1000);

    try {
        const messages = buildDraftMessages(coreChat, settings.context_messages);
        const requests = Array.from({ length: DRAFT_COUNT }, () => requestDraft(settings.source_profile, messages, controller.signal));
        const results = await Promise.allSettled(requests);
        if (signal.aborted) {
            return null;
        }

        results.filter(result => result.status === 'rejected').forEach(result => console.warn('[Seed] Draft request failed', result.reason));
        const seed = buildNarrativeSeed(results.map(result => result.status === 'fulfilled' ? result.value : ''), settings.chunks);

        if (!seed) {
            toastr.warning(t`The seed source returned nothing. Continuing without a seed.`, t`Seed`);
        } else if (seed.failed > 0) {
            toastr.info(t`Only ${seed.drafts.length} of ${DRAFT_COUNT} seed drafts arrived.`, t`Seed`);
        }
        return seed;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
    }
}

/**
 * Shows the picker before generation starts.
 * @param {NarrativeSeed} seed Freshly drawn seed; its selection is updated in place
 * @returns {Promise<number|null>} A POPUP_RESULT: AFFIRMATIVE uses it, CUSTOM1 rerolls, CUSTOM2 skips, anything else cancels
 */
async function confirmSeedBeforeGeneration(seed) {
    const container = document.createElement('div');
    container.classList.add('mes_seed_body', 'mes_seed_popup');
    const state = { seed, selection: [...seed.selection], tab: 'combined' };
    renderPicker(container, state, { editable: true });

    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Use seed`,
        cancelButton: t`Cancel`,
        customButtons: [
            { text: t`Reroll seed`, result: POPUP_RESULT.CUSTOM1 },
            { text: t`Skip seed`, result: POPUP_RESULT.CUSTOM2 },
        ],
        wide: true,
    });
    seed.selection = state.selection;
    return result;
}

/**
 * Shows the picker until the user decides, drawing new drafts on each reroll.
 * Cancel, including Escape, stops the generation.
 * @param {NarrativeSeed} firstSeed Freshly drawn seed
 * @param {object[]} coreChat Chat messages prepared for the prompt
 * @param {AbortSignal} signal Generation abort signal
 * @returns {Promise<NarrativeSeed|null>} Seed to use, or null to generate without one
 */
async function pickSeedBeforeGeneration(firstSeed, coreChat, signal) {
    let seed = firstSeed;
    while (!signal.aborted) {
        const choice = await confirmSeedBeforeGeneration(seed);
        if (choice === POPUP_RESULT.AFFIRMATIVE) {
            return seed;
        }
        if (choice === POPUP_RESULT.CUSTOM2) {
            return null;
        }
        if (choice !== POPUP_RESULT.CUSTOM1) {
            stopGeneration();
            return null;
        }
        // A failed reroll has already shown a notice, so keep the drafts on screen.
        seed = await drawSeed(coreChat, signal) ?? seed;
    }
    return null;
}

/**
 * Finds the seed a generation should use.
 * @param {object} params
 * @param {string} params.type Generation type
 * @param {object[]} params.coreChat Chat messages prepared for the prompt
 * @param {AbortSignal} params.signal Generation abort signal
 * @param {NarrativeSeed|null} params.regenerateSeed Seed of the message that regenerate deleted
 * @param {() => void} params.onDrawStart Called before drafts are requested
 * @returns {Promise<NarrativeSeed|null>} Seed to use
 */
async function resolveSeed({ type, coreChat, signal, regenerateSeed, onDrawStart }) {
    const action = nextAction;
    nextAction = null;
    let reuse = null;

    if (action?.mode === 'reuse') {
        reuse = action.seed;
    } else if (!action) {
        if (!power_user.narrative_seed.enabled) {
            return null;
        }
        if (type === 'continue') {
            // A continuation keeps following the seed the message already has, and never draws one.
            const stored = chat.at(-1)?.extra?.narrative_seed;
            return isValidNarrativeSeed(stored) ? structuredClone(stored) : null;
        }
        if (type === 'regenerate') {
            reuse = regenerateSeed;
        } else if (type === 'swipe') {
            // The new swipe has no entry yet, so the last entry is the swipe being left.
            reuse = chat.at(-1)?.swipe_info?.at(-1)?.extra?.narrative_seed;
        }
    }

    if (isValidNarrativeSeed(reuse)) {
        return structuredClone(reuse);
    }

    onDrawStart();
    const seed = await drawSeed(coreChat, signal);
    if (seed && power_user.narrative_seed.pause_before_generation && !signal.aborted) {
        return await pickSeedBeforeGeneration(seed, coreChat, signal);
    }
    return seed;
}

/**
 * Prepares the seed for a generation and injects it into the prompt.
 * @param {object} params
 * @param {string} params.type Generation type
 * @param {number} params.depth Tool-call recursion depth
 * @param {object[]} params.coreChat Chat messages prepared for the prompt
 * @param {AbortSignal} params.signal Generation abort signal
 * @param {NarrativeSeed|null} params.regenerateSeed Seed of the message that regenerate deleted
 * @param {() => void} params.onDrawStart Called before drafts are requested
 * @returns {Promise<boolean>} True if the user stopped generation while it was running
 */
export async function prepareNarrativeSeed({ type, depth, coreChat, signal, regenerateSeed, onDrawStart }) {
    clearNarrativeSeedPrompt();

    if (type === 'quiet' || type === 'impersonate') {
        return false;
    }

    // A tool-call follow-up is the same turn, so it keeps the same seed.
    if (depth === 0) {
        activeSeed = await resolveSeed({ type, coreChat, signal, regenerateSeed, onDrawStart });
        if (signal.aborted) {
            activeSeed = null;
            return true;
        }
    }

    if (activeSeed) {
        injectSeed(activeSeed);
    }
    return false;
}

/**
 * @param {string} tag Tag name
 * @param {string} className Class name
 * @param {string} [text] Text content
 * @returns {HTMLElement} Element
 */
function createElement(tag, className, text = '') {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

/**
 * Whether the message can still take a new swipe with a different seed.
 * @param {number} messageId Message ID
 * @returns {boolean}
 */
function isSeedEditable(messageId) {
    return messageId === chat.length - 1 && getOverswipeBehavior(messageId) === OVERSWIPE_BEHAVIOR.REGENERATE;
}

/**
 * Generates a new swipe using a seed action.
 * @param {number} messageId Message ID
 * @param {{mode: 'reuse', seed: NarrativeSeed}|{mode: 'draw'}} action What the generation should do
 */
async function generateSeedSwipe(messageId, action) {
    if (!isSeedEditable(messageId) || !isSwipingAllowed()) {
        toastr.warning(t`This message can't generate a new swipe right now.`, t`Seed`);
        return;
    }
    nextAction = action;
    try {
        const message = chat[messageId];
        await swipe(null, SWIPE_DIRECTION.RIGHT, { message, forceSwipeId: message.swipes?.length ?? 1 });
    } finally {
        // Set only if the swipe gave up before it reached Generate.
        if (nextAction === action) {
            nextAction = null;
        }
    }
}

/**
 * Renders the combined seed, the draft columns and the mobile tabs.
 * @param {HTMLElement} container Element to render into
 * @param {{seed: NarrativeSeed, selection: number[], tab: string}} state Picker state
 * @param {object} options
 * @param {boolean} options.editable Whether sections can be selected
 * @param {(container: HTMLElement) => void} [options.renderActions] Adds the action buttons
 */
function renderPicker(container, state, { editable, renderActions }) {
    const { seed, selection } = state;
    const rerender = () => renderPicker(container, state, { editable, renderActions });

    const tabs = createElement('div', 'mes_seed_tabs');
    const addTab = (id, label, title) => {
        const tab = createElement('button', `mes_seed_tab${state.tab === id ? ' active' : ''}`, label);
        tab.setAttribute('type', 'button');
        tab.title = title;
        tab.addEventListener('click', () => {
            state.tab = id;
            rerender();
        });
        tabs.append(tab);
    };
    addTab('combined', t`Combined`, t`Combined seed`);

    const combinedPanel = createElement('div', `mes_seed_panel mes_seed_combined${state.tab === 'combined' ? ' active' : ''}`, combineNarrativeSeed(seed, selection));
    const draftPanels = createElement('div', 'mes_seed_drafts');
    draftPanels.style.setProperty('--mes-seed-draft-count', String(seed.drafts.length));

    seed.drafts.forEach((_, draftIndex) => {
        const tabId = `draft-${draftIndex}`;
        const selectedCount = selection.filter(selected => selected === draftIndex).length;
        addTab(tabId, `${draftIndex + 1} ${'•'.repeat(selectedCount)}`.trim(), t`Draft ${draftIndex + 1}: ${selectedCount} selected`);

        const panel = createElement('div', `mes_seed_panel mes_seed_draft${state.tab === tabId ? ' active' : ''}`);
        selection.forEach((selectedDraft, slot) => {
            const isSelected = selectedDraft === draftIndex;
            const section = createElement(editable ? 'button' : 'div', `mes_seed_section${isSelected ? ' selected' : ''}`, getSeedChunk(seed, draftIndex, slot).trim() || '—');
            if (editable) {
                section.setAttribute('type', 'button');
                section.setAttribute('aria-pressed', String(isSelected));
                section.addEventListener('click', () => {
                    selection[slot] = draftIndex;
                    rerender();
                });
            }
            panel.append(section);
        });
        draftPanels.append(panel);
    });

    container.replaceChildren(tabs, combinedPanel, draftPanels);

    if (seed.failed > 0) {
        container.append(createElement('small', 'mes_seed_notice', t`${seed.failed} of ${seed.failed + seed.drafts.length} drafts failed.`));
    }
    renderActions?.(container);
}

/**
 * Renders a message's open Seed block.
 * @param {HTMLElement} details Block element
 * @param {NarrativeSeed} seed Seed stored on the message
 */
function renderBlock(details, seed) {
    const body = /** @type {HTMLElement} */ (details.querySelector('.mes_seed_body'));
    const messageId = Number(details.closest('.mes')?.getAttribute('mesid'));
    let state = pickerStates.get(details);
    if (!state || state.seed !== seed) {
        state = { seed, selection: [...seed.selection], tab: state?.tab ?? 'combined' };
        pickerStates.set(details, state);
    }
    const pickerState = state;
    const editable = isSeedEditable(messageId);

    const renderActions = (container) => {
        if (!editable) {
            return;
        }
        const actions = createElement('div', 'mes_seed_actions');
        const addButton = (label, title, disabled, onClick) => {
            const button = /** @type {HTMLButtonElement} */ (createElement('button', 'menu_button', label));
            button.setAttribute('type', 'button');
            button.title = title;
            button.disabled = disabled;
            button.classList.toggle('disabled', disabled);
            button.addEventListener('click', onClick);
            actions.append(button);
        };
        const changed = pickerState.selection.some((draftIndex, slot) => draftIndex !== seed.selection[slot]);
        addButton(t`Regenerate`, t`Write a new swipe with the selected sections`, !changed, () => {
            generateSeedSwipe(messageId, { mode: 'reuse', seed: { ...structuredClone(seed), selection: [...pickerState.selection] } });
        });
        addButton(t`Reroll narration`, t`Write a new swipe from the same seed`, false, () => {
            generateSeedSwipe(messageId, { mode: 'reuse', seed: structuredClone(seed) });
        });
        addButton(t`Reroll seed`, t`Draw three new drafts and write a new swipe`, false, () => {
            generateSeedSwipe(messageId, { mode: 'draw' });
        });
        container.append(actions);
    };

    renderPicker(body, pickerState, { editable, renderActions });
}

/**
 * Shows, hides or refreshes a message's Seed block.
 * @param {JQuery<HTMLElement>} messageElement Message element
 * @param {object} message Chat message
 * @param {object} [options]
 * @param {boolean} [options.reset] Hide the block, for a swipe that is about to generate
 */
export function updateNarrativeSeedUI(messageElement, message, { reset = false } = {}) {
    const details = messageElement.find('.mes_seed_details')[0];
    if (!(details instanceof HTMLDetailsElement)) {
        return;
    }

    const seed = reset ? null : message?.extra?.narrative_seed;
    if (!isValidNarrativeSeed(seed)) {
        details.hidden = true;
        details.open = false;
        details.querySelector('.mes_seed_body')?.replaceChildren();
        pickerStates.delete(details);
        return;
    }

    details.hidden = false;
    if (details.open) {
        renderBlock(details, seed);
    }
}

/**
 * Binds one settings control.
 * @param {string} selector Control selector
 * @param {string} key Settings key
 * @param {(value: any) => any} [parse] Converts the control's value, returning undefined to reject it
 */
function bindSetting(selector, key, parse = value => value) {
    const control = $(selector);
    const isCheckbox = control.is(':checkbox');
    if (isCheckbox) {
        control.prop('checked', power_user.narrative_seed[key]);
    } else {
        control.val(power_user.narrative_seed[key]);
    }
    control.on('change input', function () {
        const parsed = parse(isCheckbox ? !!$(this).prop('checked') : $(this).val());
        if (parsed !== undefined) {
            power_user.narrative_seed[key] = parsed;
            saveSettingsDebounced();
        }
    });
}

/**
 * @param {number} min Minimum
 * @param {number} max Maximum
 * @param {boolean} [integer] Whether to round the value
 * @returns {(value: any) => number|undefined} Parser that rejects anything out of range
 */
function numberInRange(min, max, integer = true) {
    return (value) => {
        const number = Number(value);
        if (value === '' || !Number.isFinite(number) || number < min || number > max) {
            return undefined;
        }
        return integer ? Math.trunc(number) : number;
    };
}

/**
 * Fills the source list. The connection profile code loads on first use, so a
 * feature most sessions don't open adds nothing to boot.
 */
async function loadSourceDropdown() {
    try {
        const { ConnectionManagerRequestService } = await import('./extensions/shared.js');
        ConnectionManagerRequestService.handleDropdown(
            '#narrative_seed_source',
            power_user.narrative_seed.source_profile,
            (profile) => {
                power_user.narrative_seed.source_profile = profile?.id ?? '';
                saveSettingsDebounced();
            },
        );
    } catch (error) {
        console.warn('[Seed] Could not load connection profiles', error);
        $('#narrative_seed_source').prop('disabled', true);
    }
}

/**
 * Binds the Seed settings and the block's lazy rendering.
 */
export function initNarrativeSeed() {
    bindSetting('#narrative_seed_enabled', 'enabled');
    bindSetting('#narrative_seed_pause', 'pause_before_generation');
    bindSetting('#narrative_seed_temperature', 'temperature', numberInRange(0, 5, false));
    bindSetting('#narrative_seed_max_tokens', 'max_tokens', numberInRange(1, 8192));
    bindSetting('#narrative_seed_chunks', 'chunks', numberInRange(1, 10));
    bindSetting('#narrative_seed_context', 'context_messages', numberInRange(1, 100));
    bindSetting('#narrative_seed_timeout', 'timeout_seconds', numberInRange(1, 600));
    bindSetting('#narrative_seed_template', 'template', String);

    $('#narrative_seed_template_restore').on('click', () => {
        $('#narrative_seed_template').val(DEFAULT_NARRATIVE_SEED_TEMPLATE).trigger('input');
    });

    $('#narrative_seed_drawer > .inline-drawer-toggle').one('click', () => loadSourceDropdown());

    // `toggle` doesn't bubble, so listen during capture.
    document.addEventListener('toggle', (event) => {
        const details = event.target;
        if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('mes_seed_details') || !details.open) {
            return;
        }
        const messageId = Number(details.closest('.mes')?.getAttribute('mesid'));
        const seed = chat[messageId]?.extra?.narrative_seed;
        if (isValidNarrativeSeed(seed)) {
            renderBlock(details, seed);
        }
    }, true);
}
