import {
    getConfig,
    getRoster,
    getState,
    loadWorldSimState,
    resetWorldSimState,
    saveWorldSimState,
    getRosterCharacter,
    setCharacterStrings,
    updateConfig,
    loadCycles,
    loadSnapshot,
    getScenes,
} from './state.js';
import { characters, getThumbnailUrl, printCharacters } from '../../script.js';
import { power_user } from '../power-user.js';
import { getRun } from './run-context.js';

import { startTimer, stopTimer, isTimerRunning, startCountdown } from './timer.js';
import { runCycle, addCharacterToRoster, avatarToId, initializeCharacter, startRoleplayChat, revertCycle, openScene, deleteScene, commitScene, syncHiddenScenes } from './main.js';
import { registerWorldSimTools } from './tools.js';
import { initWorldSimMap, refreshMap, selectCharacterOnMap } from './map.js';

let manualRunActive = false;
let bulkInitActive = false;
let bulkInitQueue = null;
let bulkInitPollTimer = null;
let filterIncludedOnly = false;
let searchTerm = '';
let selectedCharacterId = null;
const expandedChars = new Set();
const expandedTicks = new Set();

export async function initWorldSimUi() {
    registerWorldSimTools();
    await loadWorldSimState();
    syncHiddenScenes();
    printCharacters();
    bindEvents();
    await renderAll();
    initWorldSimMap(document.getElementById('world-sim-map'));
    startCountdown(updateCountdown);
}

function bindEvents() {
    // --- Actions ---
    $(document).on('change', '#world-sim-autorun', (e) => {
        e.stopPropagation();
        if ($(e.currentTarget).prop('checked')) {
            startTimer();
        } else {
            stopTimer();
        }
        updateStatusBar();
    });

    $(document).on('click', '#world-sim-run-now', async (e) => {
        e.stopPropagation();
        const count = Number($('#world-sim-run-count').val()) || 1;
        const roster = getRoster();
        const eligible = Object.values(roster.characters || {}).filter(c => c.included && c.initialized).length;
        if (!eligible) {
            toastr.warning('Include and initialize at least one character first.', 'World Sim');
            return;
        }
        manualRunActive = true;
        updateStatusBar();
        try {
            for (let i = 0; i < count; i++) {
                await runCycle({ ignorePaused: true });
                await renderHistory();
                updateStatusBar();
            }
        } finally {
            manualRunActive = false;
            updateStatusBar();
        }
    });

    $(document).on('click', '#world-sim-include-all', async (e) => {
        e.stopPropagation();
        const nextIncluded = !areAllCharactersIncluded();
        for (const char of characters.filter(c => c?.avatar)) {
            const entry = ensureRosterEntry(char.avatar);
            if (entry) entry.included = nextIncluded;
        }
        await saveWorldSimState();
        renderRoster();
        refreshMap();
        updateStatusBar();
        toastr.success(nextIncluded ? 'Included all characters in World Sim.' : 'Discluded all characters from World Sim.', 'World Sim');
    });

    $(document).on('click', '#world-sim-init-all', async (e) => {
        e.stopPropagation();
        if (bulkInitActive) return;

        const targets = getBulkInitializeTargets();
        if (!targets.length) {
            toastr.info('Everyone is already initialized.', 'World Sim');
            return;
        }

        const confirmed = confirm(`Initialize ${targets.length} character${targets.length === 1 ? '' : 's'} and include them in World Sim?`);
        if (!confirmed) return;
        await startBulkInitializeQueue(targets);
    });

    $(document).on('click', '#world-sim-reset-all', async (e) => {
        e.stopPropagation();
        const confirmed = confirm('Delete all World Sim data, locations, history, scenes, and initialization progress? This cannot be undone.');
        if (!confirmed) return;

        finishBulkInitializeQueue();
        stopTimer();
        for (const scene of [...getScenes()]) {
            await deleteScene(scene.sceneId);
        }
        await resetWorldSimState();
        selectedCharacterId = null;
        expandedChars.clear();
        expandedTicks.clear();
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
        if ($(e.target).closest('.world-sim-toggle, .world-sim-star').length) return;
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
        await saveWorldSimState();
    });

    $(document).on('click', '.world-sim-init-char', async function (e) {
        e.stopPropagation();
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

    // --- Mobile section tabs (Characters / Map / History / Actions) ---
    $(document).on('click', '.world-sim-mtab', function () {
        const tab = $(this).data('mtab');
        $('.world-sim-mtab').removeClass('active');
        $(this).addClass('active');
        $('.world-sim-app').attr('data-mtab', tab);
        if (tab === 'map' || tab === 'history' || tab === 'conversations') {
            $('.world-sim-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
            $('.world-sim-tabpane').removeClass('active');
            $(`#world-sim-${tab}-tab`).addClass('active');
        }
        if (tab === 'map') refreshMap();
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
        if (tab === 'conversations') renderConversations();
    });

    // --- History rows ---
    $(document).on('click', '.world-sim-tick-head', async function () {
        const $tick = $(this).closest('.world-sim-tick');
        const cycleId = $tick.data('cycle');
        if (expandedTicks.has(cycleId)) {
            expandedTicks.delete(cycleId);
            $tick.removeClass('open');
        } else {
            expandedTicks.add(cycleId);
            $tick.addClass('open');
            await fillTickBody($tick);
        }
    });

    $(document).on('click', '.world-sim-open-scene', async function (e) {
        e.stopPropagation();
        const ids = String($(this).data('ids') || '').split(',').filter(Boolean);
        if (!ids.length) return;
        const cycleId = String($(this).data('cycle') || '') || null;
        const tick = Number.isFinite(Number($(this).data('tick'))) ? Number($(this).data('tick')) : null;
        await startRoleplayChat(ids, { cycleId, tick });
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
        const confirmed = confirm('Delete this scene and its chat? This cannot be undone.');
        if (!confirmed) return;
        await deleteScene(sceneId);
        renderConversations();
    });

    $(document).on('click', '.world-sim-undo', async function (e) {
        e.stopPropagation();
        const cycleId = String($(this).data('cycle'));
        const ok = await revertCycle(cycleId);
        if (ok) {
            $(this).closest('.world-sim-tick').addClass('reverted');
            updateStatusBar();
            renderRoster();
            toastr.success('Reverted to the state before this tick.', 'World Sim');
        }
    });

    // --- Settings ---
    $(document).on('change', '.world-sim-actions-pane input[type="number"]:not(#world-sim-run-count)', async () => {
        updateConfig({
            tickIntervalMinutes: Number($('#world-sim-tick-interval').val()) || getConfig().tickIntervalMinutes,
            autoPauseIdleMinutes: Number($('#world-sim-auto-pause').val()) || getConfig().autoPauseIdleMinutes,
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
    }
    return entry;
}

async function renderAll() {
    renderRoster();
    renderSettings();
    if (!bulkInitActive) updateSetupProgress(null, 0);
    await renderHistory();
    renderConversations();
    updateStatusBar();
    updateWorldClock();
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
                <button class="world-sim-star" type="button" title="Priority"><i class="fa-solid fa-star"></i></button>
            </div>
        `);
        $row.find('.world-sim-char-avatar').attr('src', avatarUrl);
        $row.find('.world-sim-char-name').text(item.name);
        $row.find('.world-sim-include-char').prop('checked', included).attr('data-avatar', item.avatar);
        $row.find('.world-sim-star').toggleClass('active', priority).attr('data-avatar', item.avatar);
        $card.append($row);

        if (expandedChars.has(item.avatar)) {
            $card.append(buildDetail(id, strings, !!entry?.initialized));
        }

        $container.append($card);
    }
}

/**
 * @param {string} id
 * @param {object} strings
 * @param {boolean} initialized
 */
function buildDetail(id, strings, initialized) {
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
    if (initialized) {
        $actions.append('<span class="world-sim-init-badge"><i class="fa-solid fa-circle-check"></i> Initialized</span>');
    } else {
        const disabled = bulkInitActive ? ' disabled' : '';
        $actions.append(`<button class="world-sim-init-char menu_button" type="button" title="Decide this character's starting state with the AI"${disabled}>Initialize</button>`);
    }
    return $detail;
}

function renderSettings() {
    const config = getConfig();
    $('#world-sim-tick-interval').val(config.tickIntervalMinutes);
    $('#world-sim-auto-pause').val(config.autoPauseIdleMinutes);
    $('#world-sim-history-entries').val(config.historyEntriesPerCharacter);
}

async function renderHistory() {
    const cycles = await loadCycles();
    const $container = $('#world-sim-history').empty();

    if (!cycles.length) {
        $container.append('<div class="world-sim-empty">Completed ticks will appear here.</div>');
        return;
    }

    for (const cycle of cycles.slice().reverse()) {
        const failed = !cycle.updater?.ok || !cycle.selector?.ok;
        const names = (cycle.selector?.characterIds || []).map(id => getRosterCharacter(id)?.name || id).join(', ') || 'none';
        const time = formatWorldTimeFromMinutes(cycle.inWorldMinutes ?? getState().inWorldMinutes);
        const isOpen = expandedTicks.has(cycle.cycleId);

        const $tick = $('<div class="world-sim-tick"></div>')
            .attr('data-cycle', cycle.cycleId)
            .toggleClass('failed', failed)
            .toggleClass('open', isOpen);

        const $head = $(`
            <div class="world-sim-tick-head">
                <i class="fa-solid fa-chevron-right chevron"></i>
                <span class="world-sim-tick-title"></span>
                <span class="world-sim-tick-names"></span>
            </div>
        `);
        $head.find('.world-sim-tick-title').text(`Tick ${cycle.tick} · ${time}`);
        $head.find('.world-sim-tick-names').text(`# ${names}`);
        $tick.append($head);
        $tick.append('<div class="world-sim-tick-body"></div>');
        $container.append($tick);

        if (isOpen) await fillTickBody($tick);
    }
}

/**
 * Lazily renders a history tick's before/after diff body.
 * @param {JQuery} $tick
 */
async function fillTickBody($tick) {
    const $body = $tick.find('.world-sim-tick-body');
    if ($body.data('filled')) return;
    $body.data('filled', true);

    const cycleId = $tick.data('cycle');
    const cycles = await loadCycles();
    const cycle = cycles.find(c => c.cycleId === cycleId);
    if (!cycle) return;

    if (!cycle.updater?.ok) {
        $body.append($('<div class="world-sim-empty"></div>').text(cycle.updater?.error || cycle.selector?.error || 'This tick produced no update.'));
        return;
    }

    const snapshot = await loadSnapshot(cycleId);
    const before = snapshot?.characters || {};
    const updates = cycle.updater?.updates || [];

    const $grid = $('<div class="world-sim-diff-grid"></div>');
    for (const update of updates) {
        const id = update.characterId;
        const char = getRosterCharacter(id);
        const prev = before[id] || {};
        const $char = $('<div class="world-sim-diff-char"></div>');
        const $head = $('<div class="world-sim-diff-charhead"></div>');
        if (char?.avatar) $head.append($('<img alt="">').attr('src', getThumbnailUrl('avatar', char.avatar)));
        $head.append($('<span></span>').text(char?.name || id));
        $char.append($head);

        for (const field of ['activity', 'plan']) {
            $char.append(buildDiffField(field, prev[field] || '', update[field] || ''));
        }
        $grid.append($char);
    }
    $body.append($grid);

    const ids = (cycle.selector?.characterIds || []).join(',');
    const $actions = $('<div class="world-sim-tick-actions"></div>');
    $('<button class="world-sim-open-scene menu_button" type="button" title="Zoom in: open a roleplay scene for this moment (managed in the Conversations tab)"><i class="fa-solid fa-masks-theater"></i><span>Open Scene</span></button>')
        .attr('data-ids', ids)
        .attr('data-cycle', cycleId)
        .attr('data-tick', cycle.tick)
        .appendTo($actions);
    $('<button class="world-sim-undo menu_button" type="button" title="Revert the world to the state before this tick"><i class="fa-solid fa-rotate-left"></i><span>Undo</span></button>')
        .attr('data-cycle', cycleId).appendTo($actions);
    $body.append($actions);
}

/**
 * Renders the Conversations tab: the list of roleplay scenes (zoomed-in tick chats).
 * Each scene opens its backing group chat; the group itself is hidden from the main grid.
 */
function renderConversations() {
    const scenes = getScenes();
    const $container = $('#world-sim-conversations').empty();

    if (!scenes.length) {
        $container.append('<div class="world-sim-empty">No conversations yet. Use “Open Scene” on a tick in History to zoom in.</div>');
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
        const tickLabel = Number.isFinite(scene.tick) ? `Tick ${scene.tick}` : 'Free scene';
        const when = scene.createdAt ? new Date(scene.createdAt).toLocaleString() : '';
        const committed = scene.committed ? 'committed' : '';
        $('<div class="world-sim-scene-sub"></div>').text([tickLabel, when, committed].filter(Boolean).join(' · ')).appendTo($meta);

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
function buildDiffField(field, before, after) {
    const $field = $('<div class="world-sim-diff-field"></div>');
    $('<div class="world-sim-diff-label"></div>').text(field[0].toUpperCase() + field.slice(1)).appendTo($field);
    const $pair = $('<div class="world-sim-diff-pair"></div>');
    $('<div class="world-sim-diff-box before"><span class="micro">Before</span></div>').append(document.createTextNode(before || '—')).appendTo($pair);
    $('<i class="fa-solid fa-arrow-right arrow"></i>').appendTo($pair);
    $('<div class="world-sim-diff-box after"><span class="micro">After</span></div>').append(document.createTextNode(after || '—')).appendTo($pair);
    $field.append($pair);
    return $field;
}

function updateStatusBar() {
    const running = isTimerRunning();
    const state = getState();
    const roster = getRoster();
    const eligible = Object.values(roster.characters || {}).filter(c => c.included && c.initialized).length;

    $('#world-sim-autorun').prop('checked', running);
    $('#world-sim-run-now').prop('disabled', manualRunActive || bulkInitActive);
    $('#world-sim-status-dot').toggleClass('running', running && !manualRunActive);

    let status;
    if (bulkInitActive) status = 'Initializing…';
    else if (manualRunActive) status = 'Running…';
    else if (running) status = 'Running';
    else if (!eligible) status = 'Paused · no eligible characters';
    else status = 'Paused';
    $('#world-sim-status').text(status);

    $('#world-sim-status-tick').text(state.tick ?? 0);
    $('#world-sim-status-clock').text(formatWorldTime());
}

function updateCountdown(ms) {
    $('#world-sim-countdown').text(ms === null ? '—' : formatDuration(ms));
}

function updateWorldClock() {
    $('#world-sim-clock').text(formatTimeOfDay());
    $('#world-sim-status-tick').text(getState().tick ?? 0);
    $('#world-sim-status-clock').text(formatWorldTime());
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatWorldTime() {
    return formatWorldTimeFromMinutes(getState().inWorldMinutes || 0);
}

/**
 * @param {number} minutes
 */
function formatWorldTimeFromMinutes(minutes) {
    minutes = minutes || 0;
    const day = Math.floor(minutes / 1440) + 1;
    return `Day ${day} · ${formatClock(minutes)}`;
}

function formatTimeOfDay() {
    return formatClock(getState().inWorldMinutes || 0);
}

/**
 * @param {number} minutes
 */
function formatClock(minutes) {
    const hour = Math.floor((minutes % 1440) / 60);
    const minute = minutes % 60;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function getBulkInitializeTargets() {
    const targets = [];

    for (const char of characters.filter(c => c?.avatar)) {
        const entry = ensureRosterEntry(char.avatar);
        if (!entry || entry.initialized) continue;
        targets.push(entry);
    }

    return targets;
}

function updateSetupProgress(doneCount, totalCount, currentName = '') {
    const $includeButton = $('#world-sim-include-all');
    const $button = $('#world-sim-init-all');
    $includeButton.text(areAllCharactersIncluded() ? 'Disclude All' : 'Include All');

    if (!bulkInitActive || doneCount === null) {
        $button.prop('disabled', false).text('Initialize All');
        $('#world-sim-include-all, #world-sim-reset-all').prop('disabled', false);
        return;
    }

    const label = currentName ? `${currentName} ${doneCount + 1}/${totalCount}` : `Initializing ${doneCount}/${totalCount}`;
    $button.prop('disabled', true).text(label);
    $('#world-sim-include-all, #world-sim-reset-all').prop('disabled', true);
}

function activateMapView() {
    $('.world-sim-tab').removeClass('active');
    $('.world-sim-tab[data-tab="map"]').addClass('active');
    $('.world-sim-tabpane').removeClass('active');
    $('#world-sim-map-tab').addClass('active');

    $('.world-sim-mtab').removeClass('active');
    $('.world-sim-mtab[data-mtab="map"]').addClass('active');
    $('.world-sim-app').attr('data-mtab', 'map');
}

function areAllCharactersIncluded() {
    const avatarChars = characters.filter(c => c?.avatar);
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

async function startBulkInitializeQueue(targets) {
    stopBulkInitializePolling();
    bulkInitQueue = {
        ids: targets.map(target => target.id),
        total: targets.length,
        currentIndex: 0,
        currentCharacterId: null,
        unattended: canBulkInitializeUnattended(),
    };
    bulkInitActive = true;
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
    updateSetupProgress(null, 0);
    renderRoster();
    refreshMap();
    updateStatusBar();
}

export { renderAll, updateWorldClock };
