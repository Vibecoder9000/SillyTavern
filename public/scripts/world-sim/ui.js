import {
    createEmptyCharacterHistory,
    getConfig,
    getRoster,
    getState,
    loadWorldSimState,
    resetWorldSimState,
    resetCharacterWorldSimState,
    saveCurrentWorldSnapshot,
    saveWorldSimState,
    getRosterCharacter,
    setCharacterStrings,
    updateConfig,
    getScenes,
    commitWorldRevision,
    getEventHistory,
    getRevisionIndex,
    loadRevisionSnapshot,
} from './state.js';
import { characters, getThumbnailUrl, printCharacters } from '../../script.js';
import { power_user } from '../power-user.js';
import { getRun } from './run-context.js';

import { runCycle, runGuidedCycle, addCharacterToRoster, avatarToId, initializeCharacter, startRoleplayChat, openScene, deleteScene, commitScene, syncHiddenScenes, branchFromRevision } from './main.js';
import { registerWorldSimTools } from './tools.js';
import { initWorldSimMap, refreshMap, selectCharacterOnMap } from './map.js';
import { CARD_CONTEXT_TOKEN_LIMIT, ensureCharacterCardContext, getCardContextStatus, saveEditedCardContext } from './card-summary.js';
import { WORLD_CHARACTER_AVATAR } from './world-character.js';
import { getTokenCountAsync } from '../tokenizers.js';
import { Popup, POPUP_TYPE } from '../popup.js';
import { renderHistoryTimeline } from './history-timeline.js';
import { confirmWorldSimAction } from './popups.js';

let manualRunActive = false;
let guidedRunActive = false;
let fastForwardStopRequested = false;
let bulkInitActive = false;
let bulkInitStopRequested = false;
let summaryBatchActive = false;
let summaryBatchStopRequested = false;
let summaryBatchStatus = '';
let activeSummaryEditor = null;
let bulkInitQueue = null;
let bulkInitPollTimer = null;
let filterIncludedOnly = false;
let searchTerm = '';
let selectedCharacterId = null;
const expandedChars = new Set();
let worldSimToolsRegistered = false;
let worldSimUiInitPromise = null;

function ensureWorldSimToolsRegistered() {
    if (worldSimToolsRegistered) return;
    worldSimToolsRegistered = true;
    registerWorldSimTools();
}

async function initializeWorldSimUi() {
    ensureWorldSimToolsRegistered();
    await loadWorldSimState();
    if (getConfig().summaryPaused) {
        updateConfig({ summaryPaused: false });
        await saveWorldSimState();
    }
    syncHiddenScenes();
    printCharacters();
    bindEvents();
    await renderAll();
    initWorldSimMap(document.getElementById('world-sim-map'));
}

export function initWorldSimUi() {
    worldSimUiInitPromise ??= initializeWorldSimUi();
    return worldSimUiInitPromise;
}

/**
 * Registers generation tools immediately, but leaves the large roster UI
 * unrendered until the World Sim drawer is actually opened. Rendering it at
 * startup creates an avatar element for every character, even while the panel
 * is hidden, which is especially expensive on mobile clients.
 */
export function initWorldSimUiOnDemand() {
    ensureWorldSimToolsRegistered();

    const drawer = document.getElementById('world-sim-button');
    if (!drawer) return;

    const initialize = () => {
        void initWorldSimUi().catch(error => {
            console.error('Could not initialize World Sim UI', error);
            toastr.error('Could not initialize World Sim. See console for details.');
        });
    };

    drawer.addEventListener('pointerdown', initialize, { once: true, capture: true });
    drawer.addEventListener('focusin', initialize, { once: true, capture: true });
}

function bindEvents() {
    // --- Actions ---
    $(document).on('click', '#world-sim-run-now', async (e) => {
        e.stopPropagation();
        if (manualRunActive) {
            fastForwardStopRequested = true;
            updateStatusBar();
            return;
        }

        const count = Math.min(100, Math.max(1, Number($('#world-sim-run-count').val()) || 1));
        const roster = getRoster();
        const eligible = Object.values(roster.characters || {}).filter(c => c.included && c.initialized).length;
        if (!eligible) {
            toastr.warning('Include and initialize at least one character first.', 'World Sim');
            return;
        }
        if (summaryBatchActive || bulkInitActive) {
            toastr.warning('Finish or pause the current setup operation first.', 'World Sim');
            return;
        }

        manualRunActive = true;
        fastForwardStopRequested = false;
        updateStatusBar();
        try {
            for (let i = 0; i < count; i++) {
                summaryBatchStatus = `Event ${i + 1} of ${count}`;
                updateStatusBar();
                const result = await runCycle({
                    onSummaryProgress: message => {
                        summaryBatchStatus = `Event ${i + 1} of ${count} · ${message}`;
                        updateStatusBar();
                    },
                });
                await renderHistory();
                updateStatusBar();
                if (result?.status !== 'complete') {
                    const message = result?.reason || 'Fast Forward paused before the event completed.';
                    if (result?.status === 'failed') toastr.error(message, 'World Sim');
                    else if (result?.status !== 'cancelled') toastr.warning(message, 'World Sim');
                    break;
                }
                if (fastForwardStopRequested) break;
            }
        } finally {
            manualRunActive = false;
            fastForwardStopRequested = false;
            summaryBatchStatus = '';
            updateStatusBar();
        }
    });

    $(document).on('click', '#world-sim-run-guided', async (e) => {
        e.stopPropagation();
        await openGuidedRunPanel();
    });

    $(document).on('click', '#world-sim-include-all', async (e) => {
        e.stopPropagation();
        const nextIncluded = !areAllCharactersIncluded();
        for (const char of characters.filter(c => c?.avatar && c.avatar !== WORLD_CHARACTER_AVATAR)) {
            const entry = ensureRosterEntry(char.avatar);
            if (entry) entry.included = nextIncluded;
        }
        await saveWorldSimState();
        renderRoster();
        renderSettings();
        refreshMap();
        updateStatusBar();
        toastr.success(nextIncluded ? 'Included all characters in World Sim.' : 'Discluded all characters from World Sim.', 'World Sim');
    });

    $(document).on('click', '#world-sim-init-all', async (e) => {
        e.stopPropagation();
        if (bulkInitActive) {
            bulkInitStopRequested = true;
            updateSetupProgress(bulkInitQueue?.currentIndex ?? 0, bulkInitQueue?.total ?? 0);
            updateStatusBar();
            return;
        }
        if (summaryBatchActive || manualRunActive) return;

        const targets = getBulkInitializeTargets();
        if (!targets.length) {
            toastr.info('Everyone is already initialized.', 'World Sim');
            return;
        }

        const confirmed = await confirmWorldSimAction({
            title: `Initialize ${targets.length} character${targets.length === 1 ? '' : 's'}?`,
            message: 'World Sim will prepare each character and include them in the simulation.',
            detail: 'This can take a while. You can pause the queue after the current character finishes.',
            confirmLabel: 'Initialize',
            icon: 'fa-wand-magic-sparkles',
        });
        if (!confirmed) return;
        await startBulkInitializeQueue(targets);
    });

    $(document).on('click', '#world-sim-reset-all', async (e) => {
        e.stopPropagation();
        if (bulkInitActive || summaryBatchActive || manualRunActive) {
            toastr.warning('Stop the active World Sim operation before resetting.', 'World Sim');
            return;
        }
        const confirmed = await confirmWorldSimAction({
            title: 'Reset all World Sim data?',
            message: 'This deletes every location, event, scene, character state, and initialization result.',
            detail: 'This cannot be undone.',
            confirmLabel: 'Delete everything',
            icon: 'fa-trash-can',
            danger: true,
        });
        if (!confirmed) return;

        finishBulkInitializeQueue();
        for (const scene of [...getScenes()]) {
            await deleteScene(scene.sceneId);
        }
        await resetWorldSimState();
        selectedCharacterId = null;
        expandedChars.clear();
        if (activeSummaryEditor) await activeSummaryEditor.popup.completeCancelled();
        selectCharacterOnMap(null);
        renderSettings();
        await renderAll();
        toastr.success('World Sim data deleted.', 'World Sim');
    });

    // --- Roster search / filter ---
    $(document).on('input', '#world-sim-search', function () {
        searchTerm = String($(this).val() || '').trim().toLowerCase();
        renderRoster();
    });

    $(document).on('click', '#world-sim-filter-included', function (e) {
        e.stopPropagation();
        filterIncludedOnly = !filterIncludedOnly;
        $(this).toggleClass('active', filterIncludedOnly);
        renderRoster();
    });

    // --- Roster row expand ---
    $(document).on('click', '.world-sim-char-row', function (e) {
        if ($(e.target).closest('.world-sim-toggle, .world-sim-star, .world-sim-summary-toggle').length) return;
        const $card = $(this).closest('.world-sim-char');
        const avatar = $card.data('avatar');
        const id = String($card.data('id') || '');
        selectedCharacterId = id || null;
        const isOpening = !expandedChars.has(avatar);
        if (id && isOpening) {
            const highlighted = selectCharacterOnMap(id);
            if (highlighted) {
                activateMapView();
            }
        }
        if (expandedChars.has(avatar)) expandedChars.delete(avatar);
        else expandedChars.add(avatar);
        renderRoster();
    });

    $(document).on('change', '.world-sim-include-char', async function (e) {
        e.stopPropagation();
        const avatar = $(this).data('avatar');
        const char = ensureRosterEntry(avatar);
        if (!char) return;
        char.included = $(this).prop('checked');
        await saveWorldSimState();
        renderRoster();
        refreshMap();
        updateStatusBar();
    });

    $(document).on('click', '.world-sim-star', async function (e) {
        e.stopPropagation();
        const avatar = $(this).data('avatar');
        const char = ensureRosterEntry(avatar);
        if (!char) return;
        char.priority = !char.priority;
        await saveWorldSimState();
        renderRoster();
    });

    $(document).on('click', '.world-sim-summary-toggle', async function (e) {
        e.stopPropagation();
        const $card = $(this).closest('.world-sim-char');
        const entry = ensureRosterEntry(String($card.data('avatar') || ''));
        const id = String(entry?.id || '');
        if (!id) return;
        const needsSummary = !getCardContextStatus(id).context;
        if (needsSummary && (manualRunActive || summaryBatchActive || bulkInitActive)) {
            toastr.warning('Finish the current World Sim operation first.', 'World Sim');
            return;
        }
        await openSummaryEditor(id, entry.name || 'Character', this, needsSummary);
    });

    $(document).on('click', '#world-sim-summary-all', async function (e) {
        e.stopPropagation();
        if (summaryBatchActive) {
            summaryBatchStopRequested = true;
            renderSettings();
            updateStatusBar();
            return;
        }
        if (manualRunActive || bulkInitActive) return;
        await summarizeAllCharacters();
    });

    // --- Detail field edits ---
    $(document).on('change', '.world-sim-detail-field [data-field]', async function () {
        const avatar = $(this).closest('.world-sim-char').data('avatar');
        const char = ensureRosterEntry(avatar);
        if (!char) return;
        const id = char.id;
        const field = $(this).data('field');
        const value = $(this).val();
        if (field === 'x' || field === 'y') {
            setCharacterStrings(id, { [field]: value === '' ? null : Number(value) });
            refreshMap();
        } else {
            setCharacterStrings(id, { [field]: String(value) });
        }
        await saveCurrentWorldSnapshot();
    });

    $(document).on('click', '.world-sim-init-char', async function (e) {
        e.stopPropagation();
        if (summaryBatchActive || manualRunActive) return;
        const avatar = $(this).closest('.world-sim-char').data('avatar');
        const char = ensureRosterEntry(avatar);
        if (!char) return;
        const $btn = $(this);
        $btn.prop('disabled', true).text('Initializing...');
        await initializeCharacter(char.id);
        await saveWorldSimState();
        renderRoster();
        refreshMap();
        updateStatusBar();
    });

    $(document).on('click', '.world-sim-reset-char', async function (e) {
        e.stopPropagation();
        const avatar = $(this).closest('.world-sim-char').data('avatar');
        const char = ensureRosterEntry(avatar);
        if (!char) return;

        const characterName = char.name || 'this character';
        const confirmed = await confirmWorldSimAction({
            title: `Reset ${characterName}?`,
            message: 'This clears their initialization, current state, and personal World Sim history.',
            detail: 'Other characters and shared world history will be kept.',
            confirmLabel: 'Reset character',
            icon: 'fa-arrow-rotate-left',
            danger: true,
        });
        if (!confirmed) return;

        const reset = resetCharacterWorldSimState(char.id);
        if (!reset) return;

        if (selectedCharacterId === char.id) {
            selectedCharacterId = null;
            selectCharacterOnMap(null);
        }

        await commitWorldRevision({
            source: 'character-reset',
            summary: `Reset ${char.name || 'character'}`,
            eventBatch: { resetCharacterIds: [char.id] },
        });
        await renderHistory();
        renderRoster();
        refreshMap();
        updateStatusBar();
        toastr.success(`${char.name || 'Character'} reset.`, 'World Sim');
    });

    // --- Mobile section tabs (Characters / Map / History / Settings / Actions) ---
    $(document).on('click', '.world-sim-mtab', function () {
        const tab = $(this).data('mtab');
        $('.world-sim-mtab').removeClass('active');
        $(this).addClass('active');
        $('.world-sim-app').attr('data-mtab', tab);
        if (tab === 'map' || tab === 'history' || tab === 'conversations' || tab === 'settings') {
            $('.world-sim-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
            $('.world-sim-tabpane').removeClass('active');
            $(`#world-sim-${tab}-tab`).addClass('active');
        }
        if (tab === 'map') refreshMap();
        if (tab === 'history') void renderHistory();
        if (tab === 'conversations') renderConversations();
    });

    // --- Center tabs ---
    $(document).on('click', '.world-sim-tab', function () {
        const tab = $(this).data('tab');
        $('.world-sim-tab').removeClass('active');
        $(this).addClass('active');
        $('.world-sim-tabpane').removeClass('active');
        $(`#world-sim-${tab}-tab`).addClass('active');
        if (tab === 'map') refreshMap();
        if (tab === 'history') void renderHistory();
        if (tab === 'conversations') renderConversations();
    });


    $(document).on('click', '.world-sim-open-scene', async function (e) {
        e.stopPropagation();
        const ids = String($(this).data('ids') || '').split(',').filter(Boolean);
        if (!ids.length) return;
        const cycleId = String($(this).data('cycle') || '') || null;
        const baseRevisionId = String($(this).data('revision') || '') || null;
        await startRoleplayChat(ids, { cycleId, baseRevisionId });
        renderConversations();
    });

    // --- Conversation rows ---
    $(document).on('click', '.world-sim-scene-open', async function (e) {
        e.stopPropagation();
        await openScene(String($(this).data('scene')));
    });

    $(document).on('click', '.world-sim-scene-commit', async function (e) {
        e.stopPropagation();
        const $btn = $(this).prop('disabled', true);
        try {
            await commitScene(String($(this).data('scene')));
        } finally {
            $btn.prop('disabled', false);
            renderConversations();
        }
    });

    $(document).on('click', '.world-sim-scene-delete', async function (e) {
        e.stopPropagation();
        const sceneId = String($(this).data('scene'));
        const confirmed = await confirmWorldSimAction({
            title: 'Delete this scene?',
            message: 'The scene and its linked roleplay chat will both be deleted.',
            detail: 'This cannot be undone.',
            confirmLabel: 'Delete scene',
            icon: 'fa-comment-slash',
            danger: true,
        });
        if (!confirmed) return;
        await deleteScene(sceneId);
        renderConversations();
    });

    // --- Settings ---
    $(document).on('change', '#world-sim-history-entries', async () => {
        updateConfig({
            historyEntriesPerCharacter: Number($('#world-sim-history-entries').val()) || getConfig().historyEntriesPerCharacter,
        });
        await saveWorldSimState();
    });
}

/**
 * Ensures a roster entry exists for an ST character avatar, creating it on demand.
 * @param {string} avatar
 * @returns {object|undefined}
 */
function ensureRosterEntry(avatar) {
    const roster = getRoster();
    let entry = Object.values(roster.characters).find(c => c.avatar === avatar);
    if (!entry) {
        addCharacterToRoster(avatar);
        entry = Object.values(roster.characters).find(c => c.avatar === avatar);
        if (entry && !entry.history) entry.history = createEmptyCharacterHistory();
    }
    if (entry && !entry.history) entry.history = createEmptyCharacterHistory();
    return entry;
}

async function renderAll() {
    renderRoster();
    renderSettings();
    if (!bulkInitActive) updateSetupProgress(null, 0);
    await renderHistory();
    renderConversations();
    updateStatusBar();
    refreshMap();
}

function renderRoster() {
    const roster = getRoster();
    const state = getState();
    const $container = $('#world-sim-roster').empty();

    const rosterByAvatar = new Map(Object.values(roster.characters).map(c => [c.avatar, c]));
    let list = characters
        .filter(c => c?.avatar)
        .map(c => ({ avatar: c.avatar, name: c.name || c.avatar, entry: rosterByAvatar.get(c.avatar) || null }));

    if (searchTerm) list = list.filter(c => c.name.toLowerCase().includes(searchTerm));
    if (filterIncludedOnly) list = list.filter(c => c.entry?.included);

    $('#world-sim-roster-count').text(`(${list.length})`);

    if (!list.length) {
        $container.append('<div class="world-sim-empty">No characters match.</div>');
        return;
    }

    for (const item of list) {
        const entry = item.entry;
        const id = entry?.id || avatarToId(item.avatar);
        const included = !!entry?.included;
        const priority = !!entry?.priority;
        const summaryStatus = entry ? getCardContextStatus(id) : { state: 'missing', label: 'No context' };
        const strings = state.characters[id] || { location: '', activity: '', plan: '', x: '', y: '' };
        const avatarUrl = getThumbnailUrl('avatar', item.avatar);

        const $card = $('<div class="world-sim-char"></div>')
            .attr('data-id', id)
            .attr('data-avatar', item.avatar)
            .toggleClass('excluded', !included)
            .toggleClass('selected', selectedCharacterId === id);

        const $row = $(`
            <div class="world-sim-char-row">
                <img class="world-sim-char-avatar" alt="">
                <div class="world-sim-char-name"></div>
                <label class="world-sim-toggle" title="Include in simulation">
                    <input type="checkbox" class="world-sim-include-char">
                    <span class="track"></span>
                </label>
                <button class="world-sim-summary-toggle" type="button" title="View or edit character context" aria-label="View or edit character context" aria-haspopup="dialog"><i class="fa-solid fa-file-lines" aria-hidden="true"></i></button>
                <button class="world-sim-star" type="button" title="Priority"><i class="fa-solid fa-star"></i></button>
            </div>
        `);
        $row.find('.world-sim-char-avatar').attr('src', avatarUrl);
        $row.find('.world-sim-char-name').text(item.name);
        $row.find('.world-sim-include-char').prop('checked', included).attr('data-avatar', item.avatar);
        $row.find('.world-sim-summary-toggle')
            .toggleClass('active', activeSummaryEditor?.id === id)
            .toggleClass('missing', summaryStatus.state === 'missing' || summaryStatus.state === 'stale')
            .attr('aria-expanded', activeSummaryEditor?.id === id ? 'true' : 'false')
            .attr('aria-label', summaryStatus.context ? 'View or edit character context' : 'Prepare character context')
            .attr('title', summaryStatus.context ? `Card context: ${summaryStatus.label}` : 'Summarize character for World Sim');
        $row.find('.world-sim-star').toggleClass('active', priority).attr('data-avatar', item.avatar);
        $card.append($row);

        if (expandedChars.has(item.avatar)) {
            $card.append(buildDetail(id, strings, !!entry?.initialized, summaryStatus));
        }

        $container.append($card);
    }
}

/**
 * @param {string} id
 * @param {object} strings
 * @param {boolean} initialized
 */
function buildDetail(id, strings, initialized, summaryStatus) {
    const $detail = $(`
        <div class="world-sim-char-detail">
            <div class="world-sim-detail-field">
                <label>Location <em>(where the world is)</em></label>
                <input type="text" class="text_pole" data-field="location" placeholder="Place / region name">
            </div>
            <div class="world-sim-detail-field">
                <label>Position <em>(where the character is)</em></label>
                <div class="world-sim-position-row">
                    <input type="number" class="text_pole world-sim-coord" data-field="x" placeholder="X">
                    <input type="number" class="text_pole world-sim-coord" data-field="y" placeholder="Y">
                </div>
            </div>
            <div class="world-sim-detail-field">
                <label>Activity</label>
                <textarea class="text_pole" data-field="activity" placeholder="What they are doing now"></textarea>
            </div>
            <div class="world-sim-detail-field">
                <label>Plan</label>
                <textarea class="text_pole" data-field="plan" placeholder="What they intend to do"></textarea>
            </div>
            <div class="world-sim-detail-actions"></div>
        </div>
    `);
    $detail.find('[data-field="location"]').val(strings.location || '');
    $detail.find('[data-field="x"]').val(strings.x ?? '');
    $detail.find('[data-field="y"]').val(strings.y ?? '');
    $detail.find('[data-field="activity"]').val(strings.activity || '');
    $detail.find('[data-field="plan"]').val(strings.plan || '');

    const $actions = $detail.find('.world-sim-detail-actions');
    const summaryLabel = summaryStatus.context ? 'View Summary' : 'Summarize';
    $actions.append(`<button class="world-sim-summary-toggle menu_button" type="button" aria-haspopup="dialog" aria-expanded="false">${summaryLabel}</button>`);
    if (initialized) {
        $actions.append('<button class="world-sim-reset-char menu_button menu_button_warning" type="button" title="Clear this character\'s initialization, fields, and World Sim history">Reset</button>');
    } else {
        const disabled = bulkInitActive ? ' disabled' : '';
        $actions.append(`<button class="world-sim-init-char menu_button" type="button" title="Decide this character's starting state with the AI"${disabled}>Initialize</button>`);
    }
    return $detail;
}

async function openSummaryEditor(id, characterName, trigger, regenerateOnOpen = false) {
    if (activeSummaryEditor) {
        activeSummaryEditor.textarea.focus();
        return;
    }

    const initialStatus = getCardContextStatus(id);
    const content = document.createElement('section');
    content.className = 'world-sim-summary-popup';
    content.innerHTML = `
        <header class="world-sim-summary-popup-head">
            <h3 id="world-sim-summary-dialog-title"></h3>
            <div class="world-sim-summary-popup-meta" aria-live="polite">
                <span class="world-sim-summary-status"></span>
            </div>
        </header>
        <div class="world-sim-summary-popup-field">
            <textarea class="text_pole world-sim-summary-text" aria-label="Character context" autofocus spellcheck="true"></textarea>
        </div>
        <footer class="world-sim-summary-popup-actions">
            <span class="world-sim-summary-save-state" role="status" aria-live="polite"></span>
            <button class="world-sim-summary-regenerate menu_button" type="button">
                <i class="fa-solid fa-arrows-rotate"></i><span>Regenerate</span>
            </button>
        </footer>
    `;

    const title = content.querySelector('#world-sim-summary-dialog-title');
    const textarea = content.querySelector('.world-sim-summary-text');
    const status = content.querySelector('.world-sim-summary-status');
    const saveState = content.querySelector('.world-sim-summary-save-state');
    const regenerateButton = content.querySelector('.world-sim-summary-regenerate');
    title.textContent = characterName;
    textarea.value = initialStatus.context?.text || '';
    status.textContent = regenerateOnOpen ? 'Preparing…' : initialStatus.label;
    status.dataset.state = regenerateOnOpen ? '' : initialStatus.state;
    saveState.textContent = '';

    let popup;
    const session = {
        id,
        popup: null,
        trigger,
        textarea,
        status,
        saveState,
        regenerateButton,
        dirty: false,
        revision: 0,
        countTimer: null,
        saveTimer: null,
        savePromise: null,
        busyPromise: null,
        outsidePointerHandler: null,
    };

    popup = new Popup(content, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        large: true,
        leftAlign: true,
        animation: 'fast',
        onClosing: async () => {
            if (session.busyPromise) await session.busyPromise;
            return await persistSummaryDraft(session);
        },
        onClose: () => {
            clearSummaryEditorTimers(session);
            document.removeEventListener('pointerdown', session.outsidePointerHandler, true);
            if (activeSummaryEditor === session) activeSummaryEditor = null;
            renderRoster();
            const nextTrigger = Array.from(document.querySelectorAll('.world-sim-char'))
                .find(card => String(card.dataset.id || '') === id)
                ?.querySelector('.world-sim-summary-toggle');
            nextTrigger?.focus();
        },
        onOpen: () => {
            trigger.setAttribute('aria-expanded', 'true');
            textarea.focus();
            if (regenerateOnOpen) void regenerateSummaryInEditor(session);
        },
    });
    popup.dlg.classList.add('world-sim-dialog', 'world-sim-summary-dialog');
    popup.dlg.setAttribute('aria-labelledby', 'world-sim-summary-dialog-title');
    session.popup = popup;
    activeSummaryEditor = session;

    textarea.addEventListener('input', () => scheduleSummaryDraftSave(session));
    regenerateButton.addEventListener('click', () => void regenerateSummaryInEditor(session));

    session.outsidePointerHandler = event => {
        if (!popup.dlg.open || popup.dlg !== document.activeElement?.closest('.popup')) return;
        const bounds = popup.dlg.getBoundingClientRect();
        const outside = event.clientX < bounds.left
            || event.clientX > bounds.right
            || event.clientY < bounds.top
            || event.clientY > bounds.bottom;
        if (outside) void popup.completeCancelled();
    };

    const popupResult = popup.show();
    document.addEventListener('pointerdown', session.outsidePointerHandler, true);
    await popupResult;
}

function scheduleSummaryDraftSave(session) {
    session.dirty = true;
    session.revision++;
    session.saveState.textContent = '';
    session.saveState.dataset.state = '';
    clearTimeout(session.countTimer);
    clearTimeout(session.saveTimer);

    const revision = session.revision;
    session.countTimer = setTimeout(async () => {
        const count = await getTokenCountAsync(session.textarea.value, 0);
        if (revision !== session.revision || activeSummaryEditor !== session) return;
        session.status.textContent = `${count} / ${CARD_CONTEXT_TOKEN_LIMIT} tokens · edited`;
        session.status.dataset.state = count > CARD_CONTEXT_TOKEN_LIMIT ? 'stale' : 'edited';
        if (count > CARD_CONTEXT_TOKEN_LIMIT) {
            clearTimeout(session.saveTimer);
            session.saveState.textContent = 'Over token limit — not saved';
            session.saveState.dataset.state = 'error';
        }
    }, 200);

    session.saveTimer = setTimeout(() => void persistSummaryDraft(session), 800);
}

async function persistSummaryDraft(session) {
    clearTimeout(session.saveTimer);
    if (session.savePromise) await session.savePromise;
    if (!session.dirty) return true;

    const draft = session.textarea.value;
    session.saveState.textContent = '';
    session.saveState.dataset.state = '';
    session.savePromise = (async () => {
        try {
            const context = await saveEditedCardContext(session.id, draft);
            if (session.textarea.value === draft) {
                session.textarea.value = context.text;
                session.dirty = false;
                const nextStatus = getCardContextStatus(session.id);
                session.status.textContent = nextStatus.label;
                session.status.dataset.state = nextStatus.state;
                session.saveState.textContent = '';
                session.saveState.dataset.state = '';
            } else {
                scheduleSummaryDraftSave(session);
            }
            return true;
        } catch (error) {
            session.saveState.textContent = error?.message || String(error);
            session.saveState.dataset.state = 'error';
            return false;
        } finally {
            session.savePromise = null;
        }
    })();
    return await session.savePromise;
}

async function regenerateSummaryInEditor(session) {
    if (manualRunActive || summaryBatchActive || bulkInitActive || session.busyPromise) {
        toastr.warning('Finish the current World Sim operation first.', 'World Sim');
        return;
    }
    if (!await persistSummaryDraft(session)) return;

    session.busyPromise = (async () => {
        const previousText = session.textarea.value;
        let succeeded = false;
        session.textarea.readOnly = true;
        session.textarea.value = '';
        session.textarea.classList.add('world-sim-summary-streaming');
        session.regenerateButton.disabled = true;
        session.status.textContent = 'Preparing…';
        session.status.dataset.state = '';
        session.saveState.textContent = '';
        session.saveState.dataset.state = '';
        try {
            const context = await ensureCharacterCardContext(session.id, {
                force: true,
                ignorePaused: true,
                onProgress: message => {
                    session.status.textContent = message;
                },
                onStream: update => renderSummaryGenerationStream(session, update),
            });
            session.textarea.value = context.text || '';
            session.dirty = false;
            succeeded = true;
            const nextStatus = getCardContextStatus(session.id);
            session.status.textContent = nextStatus.label;
            session.status.dataset.state = nextStatus.state;
            session.saveState.textContent = '';
            session.saveState.dataset.state = '';
            toastr.success('Character context regenerated.', 'World Sim');
        } catch (error) {
            session.textarea.value = previousText;
            session.saveState.textContent = error?.message || String(error);
            session.saveState.dataset.state = 'error';
            toastr.error(error?.message || String(error), 'World Sim Context');
        } finally {
            session.textarea.readOnly = false;
            session.textarea.classList.remove('world-sim-summary-streaming', 'world-sim-summary-streaming-reasoning');
            session.regenerateButton.disabled = false;
            if (!succeeded) {
                const priorStatus = getCardContextStatus(session.id);
                session.status.textContent = priorStatus.context ? priorStatus.label : 'Generation failed';
                session.status.dataset.state = priorStatus.context ? priorStatus.state : 'missing';
            }
            session.textarea.focus();
            updateStatusBar();
        }
    })();
    await session.busyPromise;
    session.busyPromise = null;
}

function renderSummaryGenerationStream(session, update) {
    const reasoning = String(update?.reasoning || '');
    const content = String(update?.content || '');
    const showingReasoning = Boolean(update?.isThinking && reasoning);
    session.textarea.value = showingReasoning ? reasoning : content;
    session.textarea.classList.toggle('world-sim-summary-streaming-reasoning', showingReasoning);
    session.status.textContent = showingReasoning ? 'Reasoning…' : 'Writing context…';
    session.status.dataset.state = '';
    session.textarea.scrollTop = session.textarea.scrollHeight;
}

function clearSummaryEditorTimers(session) {
    clearTimeout(session.countTimer);
    clearTimeout(session.saveTimer);
    session.trigger?.setAttribute('aria-expanded', 'false');
}

function renderSettings() {
    const config = getConfig();
    $('#world-sim-history-entries').val(config.historyEntriesPerCharacter);
    renderSetupControls();
}

async function renderHistory() {
    const timelineContainer = document.getElementById('world-sim-history');
    if (timelineContainer) {
        renderHistoryTimeline(timelineContainer, getEventHistory(), getRoster(), {
            onCreateOption: event => openGuidedRunPanel({
                baseRevisionId: event.revisionId,
                parentSummary: event.summary,
            }),
        });
    }
}

async function openGuidedRunPanel({ baseRevisionId = null, parentSummary = '' } = {}) {
    if (manualRunActive || summaryBatchActive || bulkInitActive) {
        toastr.warning('Finish or pause the current World Sim operation first.', 'World Sim');
        return null;
    }

    const revisionIndex = getRevisionIndex();
    const snapshot = baseRevisionId && baseRevisionId !== revisionIndex.headId
        ? await loadRevisionSnapshot(baseRevisionId)
        : null;
    const eligible = Object.values(getRoster().characters || {})
        .filter(character => character.included && (snapshot?.characters?.[character.id]?.initialized ?? character.initialized))
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    if (!eligible.length) {
        toastr.warning('Include and initialize at least one character first.', 'World Sim');
        return null;
    }

    const content = document.createElement('section');
    content.className = 'world-sim-guided-run';
    content.innerHTML = `
        <header class="world-sim-popup-hero">
            <div class="world-sim-popup-hero-icon" aria-hidden="true"><i class="fa-solid fa-compass"></i></div>
            <div class="world-sim-popup-hero-copy">
                <h3 id="world-sim-guided-dialog-title"></h3>
                <div class="world-sim-guided-parent"></div>
            </div>
        </header>
        <label class="world-sim-guided-action">
            <strong>What happens next?</strong>
            <textarea class="text_pole" rows="6" required autofocus placeholder="Describe the action or direction for this event…"></textarea>
        </label>
        <details class="world-sim-guided-characters">
            <summary>Characters <span>(optional)</span></summary>
            <div class="world-sim-guided-character-help">Leave everyone on Automatic to let the model choose.</div>
            <div class="world-sim-guided-character-list"></div>
            <label class="world-sim-guided-exact checkbox_label">
                <input type="checkbox">
                <span>Use only the required characters</span>
            </label>
        </details>
        <footer class="world-sim-guided-actions">
            <button class="world-sim-guided-cancel menu_button" type="button">Cancel</button>
            <button class="world-sim-guided-submit menu_button" type="button" disabled>Run</button>
        </footer>
    `;

    content.querySelector('h3').textContent = baseRevisionId ? 'Create next option' : 'Run with guidance';
    const parent = content.querySelector('.world-sim-guided-parent');
    parent.textContent = baseRevisionId
        ? `After: ${parentSummary || 'selected event'}`
        : 'Continues from the latest event';
    const list = content.querySelector('.world-sim-guided-character-list');
    for (const character of eligible) {
        const row = document.createElement('label');
        row.className = 'world-sim-guided-character';
        const name = document.createElement('span');
        name.textContent = character.name || character.id;
        const select = document.createElement('select');
        select.className = 'text_pole';
        select.dataset.characterId = character.id;
        select.innerHTML = '<option value="auto">Automatic</option><option value="include">Must involve</option><option value="exclude">Must not involve</option>';
        row.append(name, select);
        list.append(row);
    }

    const textarea = content.querySelector('textarea');
    const exact = content.querySelector('.world-sim-guided-exact input');
    const cancel = content.querySelector('.world-sim-guided-cancel');
    const submit = content.querySelector('.world-sim-guided-submit');
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wider: true, large: true, leftAlign: true, animation: 'fast' });
    popup.dlg.classList.add('world-sim-dialog', 'world-sim-guided-dialog');
    popup.dlg.setAttribute('aria-labelledby', 'world-sim-guided-dialog-title');
    let outcome = null;
    textarea.addEventListener('input', () => { submit.disabled = !textarea.value.trim(); });
    cancel.addEventListener('click', () => void popup.completeCancelled());
    submit.addEventListener('click', async () => {
        const guidance = textarea.value.trim();
        if (!guidance) return;
        const includedCharacterIds = [];
        const excludedCharacterIds = [];
        for (const select of list.querySelectorAll('select[data-character-id]')) {
            if (select.value === 'include') includedCharacterIds.push(select.dataset.characterId);
            if (select.value === 'exclude') excludedCharacterIds.push(select.dataset.characterId);
        }
        if (exact.checked && !includedCharacterIds.length) {
            toastr.warning('Mark at least one character as Must involve, or turn off exact selection.', 'World Sim');
            return;
        }

        submit.disabled = true;
        cancel.disabled = true;
        guidedRunActive = true;
        manualRunActive = true;
        summaryBatchStatus = 'Guided event';
        updateStatusBar();
        try {
            outcome = await runGuidedCycle({
                guidance,
                baseRevisionId,
                includedCharacterIds,
                excludedCharacterIds,
                exactCharacterSelection: exact.checked,
            });
            if (outcome?.status === 'complete') {
                await popup.completeAffirmative();
                await renderAll();
            } else if (outcome?.status !== 'cancelled') {
                toastr.warning(outcome?.reason || 'The guided event did not complete.', 'World Sim');
            }
        } catch (error) {
            console.error(error);
            toastr.error(error?.message || String(error), 'World Sim');
        } finally {
            guidedRunActive = false;
            manualRunActive = false;
            summaryBatchStatus = '';
            updateStatusBar();
            if (submit.isConnected) submit.disabled = !textarea.value.trim();
            if (cancel.isConnected) cancel.disabled = false;
        }
    });

    await popup.show();
    return outcome;
}

function scrollRevisionHeadIntoView() {
    document.querySelector('.world-sim-revision-node.current')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

async function openRevisionDetails(revisionId) {
    const revision = getRevisionIndex().revisions?.[revisionId];
    if (!revision) return;
    const parentSnapshot = revision.parentId ? await loadRevisionSnapshot(revision.parentId) : null;
    const content = document.createElement('section');
    content.className = 'world-sim-revision-popup';
    const characterRows = Object.entries(revision.characterChanges || {}).map(([id, fields]) => {
        const name = getRosterCharacter(id)?.name || id;
        const changes = Object.entries(fields || {}).map(([field, values]) => `${field}: ${String(values.before ?? '—')} → ${String(values.after ?? '—')}`).join('\n');
        return `${name}\n${changes}`;
    }).join('\n\n');
    content.innerHTML = `
        <header class="world-sim-popup-hero">
            <div class="world-sim-popup-hero-icon" aria-hidden="true"><i class="fa-solid fa-code-branch"></i></div>
            <div class="world-sim-popup-hero-copy">
                <h3 id="world-sim-revision-dialog-title"></h3>
                <div class="world-sim-revision-popup-meta"></div>
            </div>
        </header>
        <section class="world-sim-revision-changes" aria-labelledby="world-sim-revision-changes-title">
            <h4 id="world-sim-revision-changes-title">Changes in this revision</h4>
            <pre class="world-sim-revision-popup-diffs"></pre>
        </section>
        <label class="world-sim-revision-guidance">
            <strong>Continue from here</strong>
            <span>Describe how this alternate path should unfold.</span>
            <textarea class="text_pole" rows="5" required placeholder="What happens next?"></textarea>
        </label>
        <footer class="world-sim-revision-actions">
            <button class="world-sim-branch-action menu_button" type="button" disabled><i class="fa-solid fa-code-branch"></i><span>Create branch</span></button>
        </footer>
    `;
    content.querySelector('h3').textContent = revision.summary || 'World revision';
    content.querySelector('.world-sim-revision-popup-meta').textContent = revision.source || 'world';
    const generation = revision.generation ? `Generation metadata:\n${JSON.stringify(revision.generation, null, 2)}` : '';
    content.querySelector('.world-sim-revision-popup-diffs').textContent = [characterRows, ...(revision.sharedWorldChanges || []), generation].filter(Boolean).join('\n\n') || (parentSnapshot ? 'No summarized field changes.' : 'Root snapshot.');
    const textarea = content.querySelector('textarea');
    const button = content.querySelector('.world-sim-branch-action');
    textarea.addEventListener('input', () => { button.disabled = !textarea.value.trim(); });
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wider: true, large: true, leftAlign: true });
    popup.dlg.classList.add('world-sim-dialog', 'world-sim-revision-dialog');
    popup.dlg.setAttribute('aria-labelledby', 'world-sim-revision-dialog-title');
    button.addEventListener('click', async () => {
        const guidance = textarea.value;
        if (!guidance.trim()) return;
        button.disabled = true;
        const result = await branchFromRevision(revisionId, guidance);
        if (result?.status === 'complete') {
            await popup.completeAffirmative();
            await renderAll();
        } else {
            button.disabled = false;
            toastr.warning(result?.reason || 'The branch did not complete.', 'World Sim');
        }
    });
    await popup.show();
}

/**
 * Renders the Conversations tab: the list of expanded roleplay scenes.
 * Each scene opens its backing group chat; the group itself is hidden from the main grid.
 */
function renderConversations() {
    const scenes = getScenes();
    const $container = $('#world-sim-conversations').empty();

    if (!scenes.length) {
        $container.append('<div class="world-sim-empty">No conversations yet. Use “Open Scene” on an event in History to zoom in.</div>');
        return;
    }

    for (const scene of scenes.slice().reverse()) {
        const $scene = $('<div class="world-sim-scene"></div>')
            .attr('data-scene', scene.sceneId)
            .toggleClass('committed', !!scene.committed);

        const $avatars = $('<div class="world-sim-scene-avatars"></div>');
        for (const id of scene.characterIds || []) {
            const char = getRosterCharacter(id);
            if (char?.avatar) {
                $avatars.append($('<img alt="">').attr('src', getThumbnailUrl('avatar', char.avatar)).attr('title', char.name || id));
            }
        }

        const $meta = $('<div class="world-sim-scene-meta"></div>');
        $('<div class="world-sim-scene-title"></div>').text(scene.title || 'Scene').appendTo($meta);
        const when = scene.createdAt ? new Date(scene.createdAt).toLocaleString() : '';
        const committed = scene.committed ? 'committed' : '';
        $('<div class="world-sim-scene-sub"></div>').text([when, committed].filter(Boolean).join(' · ')).appendTo($meta);

        const $actions = $('<div class="world-sim-scene-actions"></div>');
        $('<button class="world-sim-scene-open menu_button" type="button" title="Open this scene"><i class="fa-solid fa-up-right-from-square"></i></button>')
            .attr('data-scene', scene.sceneId).appendTo($actions);
        $('<button class="world-sim-scene-commit menu_button" type="button" title="Commit this scene back to world state (collapse it into the characters\' summaries)"><i class="fa-solid fa-down-left-and-up-right-to-center"></i></button>')
            .attr('data-scene', scene.sceneId).appendTo($actions);
        $('<button class="world-sim-scene-delete menu_button menu_button_icon" type="button" title="Delete this scene"><i class="fa-solid fa-trash-can"></i></button>')
            .attr('data-scene', scene.sceneId).appendTo($actions);

        $scene.append($avatars, $meta, $actions);
        $container.append($scene);
    }
}

/**
 * @param {string} field
 * @param {string} before
 * @param {string} after
 */
function updateStatusBar() {
    const roster = getRoster();
    const eligible = Object.values(roster.characters || {}).filter(c => c.included && c.initialized).length;
    renderSetupControls();

    $('#world-sim-run-now')
        .prop('disabled', bulkInitActive || summaryBatchActive || guidedRunActive)
        .toggleClass('menu_button_warning', manualRunActive && fastForwardStopRequested)
        .html(manualRunActive
            ? (fastForwardStopRequested
                ? '<span>Stopping…</span>'
                : '<span>Stop After Event</span>')
            : '<span>Continue</span>');
    $('#world-sim-run-guided').prop('disabled', manualRunActive || summaryBatchActive || bulkInitActive);
    $('#world-sim-run-count').prop('disabled', guidedRunActive);
    $('#world-sim-status-dot').toggleClass('running', manualRunActive || summaryBatchActive || bulkInitActive);

    let status;
    if (bulkInitActive && bulkInitStopRequested) status = 'Pausing initialization after current character…';
    else if (bulkInitActive) status = 'Initializing…';
    else if (summaryBatchActive && summaryBatchStopRequested) status = 'Pausing summarization after current character…';
    else if (summaryBatchActive) status = summaryBatchStatus || 'Summarizing…';
    else if (guidedRunActive) status = 'Running guided event…';
    else if (manualRunActive) status = summaryBatchStatus || 'Fast forwarding…';
    else if (!eligible) status = 'Paused · no eligible characters';
    else status = 'Ready';
    $('#world-sim-status').text(status);

}

function getBulkInitializeTargets() {
    const targets = [];

    for (const char of characters.filter(c => c?.avatar && c.avatar !== WORLD_CHARACTER_AVATAR)) {
        const entry = ensureRosterEntry(char.avatar);
        if (!entry || entry.initialized) continue;
        targets.push(entry);
    }

    return targets;
}

async function summarizeAllCharacters() {
    const targets = [];
    for (const character of characters.filter(item => item?.avatar && item.avatar !== WORLD_CHARACTER_AVATAR)) {
        const entry = ensureRosterEntry(character.avatar);
        if (entry) targets.push(entry);
    }
    if (!targets.length) {
        toastr.info('No character cards are available to summarize.', 'World Sim');
        return;
    }

    summaryBatchActive = true;
    summaryBatchStopRequested = false;
    summaryBatchStatus = `Preparing ${targets.length} characters…`;
    renderSettings();
    updateStatusBar();
    let completed = 0;
    try {
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            summaryBatchStatus = `${target.name} · ${i + 1} of ${targets.length}`;
            renderSettings();
            updateStatusBar();
            await ensureCharacterCardContext(target.id, {
                ignorePaused: true,
                onProgress: message => {
                    summaryBatchStatus = `${i + 1} of ${targets.length} · ${message}`;
                    renderSettings();
                    updateStatusBar();
                },
            });
            completed += 1;
            renderRoster();
            if (summaryBatchStopRequested) break;
        }
        if (summaryBatchStopRequested) {
            toastr.info(`Summarization paused after ${completed} of ${targets.length} characters.`, 'World Sim');
        } else {
            toastr.success(`Prepared summaries for ${completed} characters.`, 'World Sim');
        }
    } catch (error) {
        toastr.error(error?.message || String(error), 'World Sim Summary');
    } finally {
        summaryBatchActive = false;
        summaryBatchStopRequested = false;
        summaryBatchStatus = '';
        await saveWorldSimState();
        renderSettings();
        renderRoster();
        updateStatusBar();
    }
}

function updateSetupProgress(doneCount, totalCount, currentName = '') {
    renderSetupControls();
    if (!bulkInitActive || doneCount === null) return;
    const progress = currentName ? `${currentName} ${doneCount + 1}/${totalCount}` : `Initializing ${doneCount}/${totalCount}`;
    $('#world-sim-init-all').attr('title', progress);
}

function renderSetupControls() {
    const setupBusy = manualRunActive || bulkInitActive || summaryBatchActive;
    $('#world-sim-include-all')
        .prop('disabled', setupBusy)
        .html(`<span>${areAllCharactersIncluded() ? 'Disclude All' : 'Include All'}</span>`);

    $('#world-sim-init-all')
        .prop('disabled', bulkInitStopRequested || summaryBatchActive || manualRunActive)
        .attr('title', bulkInitActive ? 'Stop initialization after the current character finishes' : 'Initialize every character that has not been initialized yet')
        .html(bulkInitActive
            ? (bulkInitStopRequested
                ? '<span>Pausing After Current…</span>'
                : '<span>Pause Initialization</span>')
            : '<span>Initialize All</span>');

    $('#world-sim-summary-all')
        .prop('disabled', summaryBatchStopRequested || bulkInitActive || manualRunActive)
        .attr('title', summaryBatchActive ? 'Stop summarization after the current character finishes' : 'Prepare World Sim context for every character')
        .html(summaryBatchActive
            ? (summaryBatchStopRequested
                ? '<span>Pausing After Current…</span>'
                : '<span>Pause Summarization</span>')
            : '<span>Summarize All</span>');

    $('#world-sim-reset-all').prop('disabled', setupBusy);
}

function activateMapView() {
    $('.world-sim-tab').removeClass('active');
    $('.world-sim-tab[data-tab="map"]').addClass('active');
    $('.world-sim-tabpane').removeClass('active');
    $('#world-sim-map-tab').addClass('active');

    $('.world-sim-mtab').removeClass('active');
    $('.world-sim-mtab[data-mtab="map"]').addClass('active');
    $('.world-sim-app').attr('data-mtab', 'map');
    refreshMap({ viewBox: true, grid: true, locations: true, pins: true, list: true });
}

function areAllCharactersIncluded() {
    const avatarChars = characters.filter(c => c?.avatar && c.avatar !== WORLD_CHARACTER_AVATAR);
    const roster = getRoster();
    if (!avatarChars.length) return false;

    for (const char of avatarChars) {
        const entry = Object.values(roster.characters || {}).find(item => item.avatar === char.avatar);
        if (!entry?.included) return false;
    }

    return true;
}

function canBulkInitializeUnattended() {
    return !power_user.tool_click_to_execute && !!power_user.tool_auto_continue;
}

function shouldBulkInitializeAutoAdvance() {
    return !!power_user.tool_auto_continue;
}

async function startBulkInitializeQueue(targets) {
    stopBulkInitializePolling();
    bulkInitQueue = {
        ids: targets.map(target => target.id),
        total: targets.length,
        currentIndex: 0,
        currentCharacterId: null,
        autoAdvance: shouldBulkInitializeAutoAdvance(),
        unattended: canBulkInitializeUnattended(),
    };
    bulkInitActive = true;
    bulkInitStopRequested = false;
    updateSetupProgress(0, targets.length);
    renderRoster();
    refreshMap();
    updateStatusBar();
    await continueBulkInitializeQueue();
}

async function continueBulkInitializeQueue() {
    if (!bulkInitQueue) return;

    if (bulkInitQueue.currentIndex >= bulkInitQueue.total) {
        const total = bulkInitQueue.total;
        finishBulkInitializeQueue();
        toastr.success(`Initialized ${total} character${total === 1 ? '' : 's'}.`, 'World Sim');
        return;
    }

    const id = bulkInitQueue.ids[bulkInitQueue.currentIndex];
    const target = getRosterCharacter(id);
    if (!target) {
        bulkInitQueue.currentIndex += 1;
        await continueBulkInitializeQueue();
        return;
    }

    target.included = true;
    bulkInitQueue.currentCharacterId = id;
    await saveWorldSimState();
    updateSetupProgress(bulkInitQueue.currentIndex, bulkInitQueue.total, bulkInitQueue.unattended ? 'Initializing' : 'Waiting');
    renderRoster();
    refreshMap();
    updateStatusBar();

    await initializeCharacter(id);
    startBulkInitializePolling();
}

function startBulkInitializePolling() {
    stopBulkInitializePolling();
    bulkInitPollTimer = setInterval(() => {
        void pollBulkInitializeQueue();
    }, 700);
}

function stopBulkInitializePolling() {
    if (bulkInitPollTimer !== null) {
        clearInterval(bulkInitPollTimer);
        bulkInitPollTimer = null;
    }
}

async function pollBulkInitializeQueue() {
    if (!bulkInitQueue) {
        stopBulkInitializePolling();
        return;
    }

    const id = bulkInitQueue.currentCharacterId;
    const target = id ? getRosterCharacter(id) : null;
    if (target?.initialized) {
        bulkInitQueue.currentIndex += 1;
        bulkInitQueue.currentCharacterId = null;
        stopBulkInitializePolling();
        await saveWorldSimState();
        renderRoster();
        refreshMap();
        updateStatusBar();

        if (bulkInitStopRequested) {
            const completed = bulkInitQueue.currentIndex;
            const total = bulkInitQueue.total;
            finishBulkInitializeQueue();
            toastr.info(`Initialization paused after ${completed} of ${total} characters.`, 'World Sim');
            return;
        }

        if (!bulkInitQueue.autoAdvance && bulkInitQueue.currentIndex < bulkInitQueue.total) {
            finishBulkInitializeQueue();
            toastr.info('Bulk initialize paused because Auto-continue after tools is off.', 'World Sim');
            return;
        }

        await continueBulkInitializeQueue();
        return;
    }

    if (!target) {
        finishBulkInitializeQueue();
        return;
    }

    const run = getRun();
    if (!run && !target.initialized && bulkInitQueue.unattended) {
        finishBulkInitializeQueue();
        toastr.warning('Bulk initialize stopped before the current character finished.', 'World Sim');
    }
}

function finishBulkInitializeQueue() {
    stopBulkInitializePolling();
    bulkInitQueue = null;
    bulkInitActive = false;
    bulkInitStopRequested = false;
    updateSetupProgress(null, 0);
    renderRoster();
    refreshMap();
    updateStatusBar();
}

export { renderAll };
