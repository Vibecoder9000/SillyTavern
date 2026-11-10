// The run stepper: shows the current (or last) World Sim run as steps with what is
// happening, what the user can do now, and the controls to steer it (see run-context.js).

import { getThumbnailUrl } from '../../script.js';
import { getRoster } from './state.js';
import { getRunState, onRunChange, updateRun } from './run-context.js';
import { abortRun, confirmSelection, getReturnTarget, goBackToPreviousChat, retryRun, showRunInChat } from './run-driver.js';

const MAX_SELECTED = 10;

const PIPELINES = {
    event: ['Select characters', 'Prepare context', 'Update world', 'Committed'],
    initialize: ['Prepare context', 'Initialize character', 'Committed'],
    commit: ['Update world', 'Committed'],
};

let container = null;
let hooks = {};
let dismissedCycleId = null;

/**
 * @param {HTMLElement} element
 * @param {{ onShowOnGraph?: (revisionId: string) => void }} [callbacks]
 */
export function initRunStepper(element, callbacks = {}) {
    container = element;
    hooks = callbacks;
    onRunChange(() => renderRunStepper());
    renderRunStepper();
}

function pipelineFor(run) {
    return run.mode === 'initialize' ? PIPELINES.initialize : run.mode === 'commit' ? PIPELINES.commit : PIPELINES.event;
}

/** Index into the run's pipeline of the step currently shown as active. */
function activeStepIndex(run) {
    const steps = pipelineFor(run);
    if (run.stage === 'committed') return steps.length - 1;
    let stage = run.stage;
    if (['stalled', 'stopped', 'failed', 'waiting-for-user'].includes(stage)) {
        stage = stage === 'waiting-for-user' ? (run.updaterStarted ? 'updating' : run.mode === 'initialize' ? 'updating' : 'selecting') : (run.resumeStage || 'selecting');
    }
    if (run.mode === 'initialize') return stage === 'preparing-context' ? 0 : 1;
    if (run.mode === 'commit') return 0;
    if (stage === 'selecting' || stage === 'selection-ready') return 0;
    if (stage === 'preparing-context') return 1;
    return 2;
}

function toolNameForStep(run) {
    if (run.mode === 'initialize') return 'world_initialize';
    if (run.mode === 'commit') return 'world_update';
    return run.updaterStarted ? 'world_update' : 'select_characters';
}

/** One-line description of the run for the footer status. */
export function describeRunStatus(run) {
    if (!run) return '';
    const step = pipelineFor(run)[activeStepIndex(run)];
    switch (run.stage) {
        case 'selecting': return 'Choosing who takes part…';
        case 'selection-ready': return 'Review the selected characters, then update the world.';
        case 'preparing-context': return 'Preparing character context…';
        case 'updating': return run.mode === 'initialize' ? 'Initializing the character…' : 'Writing the event…';
        case 'waiting-for-user': return `${toolNameForStep(run)} is waiting in chat — execute it to continue.`;
        case 'stalled': return `Stalled at “${step}”. ${run.stageNote || ''}`.trim();
        case 'stopped': return `Stopped at “${step}”. Retry or abort.`;
        case 'failed': return `Failed at “${step}”. ${run.stageNote || ''}`.trim();
        case 'committed': return run.summary ? `Committed: ${run.summary}` : 'Committed.';
        default: return '';
    }
}

function stageDetail(run) {
    switch (run.stage) {
        case 'selecting': return 'The model is choosing who takes part. It should call select_characters.';
        case 'selection-ready': return 'Check who takes part. Remove or add characters, then update the world.';
        case 'preparing-context': return 'Summarizing character cards where needed.';
        case 'updating': return run.mode === 'initialize' ? 'The model is deciding the starting state.' : 'The model is writing what happens. It should call world_update.';
        case 'waiting-for-user': return `${toolNameForStep(run)} is waiting in chat. Edit the arguments if you want, then execute it.`;
        case 'stalled': return run.stageNote || 'The run stalled before the tool was called.';
        case 'stopped': return 'Generation was stopped. The tool is still available in chat.';
        case 'failed': return run.stageNote || 'The step failed.';
        case 'committed': return run.summary || 'The event was committed.';
        default: return '';
    }
}

function avatarChip(characterId, { removable = false } = {}) {
    const character = getRoster().characters?.[characterId];
    const chip = document.createElement('span');
    chip.className = 'world-sim-chip';
    chip.dataset.characterId = characterId;
    if (character?.avatar) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = getThumbnailUrl('avatar', character.avatar);
        chip.append(img);
    }
    const name = document.createElement('span');
    name.textContent = character?.name || characterId;
    chip.append(name);
    if (removable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'world-sim-chip-remove';
        remove.dataset.removeCharacter = characterId;
        remove.title = `Remove ${character?.name || characterId}`;
        remove.setAttribute('aria-label', remove.title);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        chip.append(remove);
    }
    return chip;
}

function button(label, className, action, icon = '') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `menu_button ${className}`.trim();
    element.dataset.stepperAction = action;
    element.innerHTML = icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>` : '<span></span>';
    element.querySelector('span').textContent = label;
    return element;
}

export function renderRunStepper() {
    if (!container) return;
    const { active, run } = getRunState();
    const visible = run && (active || (run.cycleId !== dismissedCycleId && ['committed', 'failed', 'stopped'].includes(run.stage)));
    container.hidden = !visible;
    container.replaceChildren();
    if (!visible) return;

    container.dataset.stage = run.stage;
    const steps = pipelineFor(run);
    const current = activeStepIndex(run);
    const list = document.createElement('ol');
    list.className = 'world-sim-stepper-steps';
    steps.forEach((label, index) => {
        const item = document.createElement('li');
        const done = run.stage === 'committed' || index < current;
        const trouble = index === current && ['stalled', 'stopped', 'failed'].includes(run.stage);
        item.className = [done ? 'is-done' : '', index === current && !done ? 'is-active' : '', trouble ? 'is-trouble' : ''].filter(Boolean).join(' ');
        if (index === current) item.setAttribute('aria-current', 'step');
        item.textContent = label;
        list.append(item);
    });
    container.append(list);

    const detail = document.createElement('p');
    detail.className = 'world-sim-stepper-detail';
    detail.setAttribute('role', 'status');
    detail.textContent = stageDetail(run);
    container.append(detail);

    const ids = run.characterIds || [];
    const reviewing = active && run.stage === 'selection-ready';
    if (ids.length && run.mode !== 'initialize') {
        const chips = document.createElement('div');
        chips.className = 'world-sim-stepper-chips';
        for (const id of ids) chips.append(avatarChip(id, { removable: reviewing }));
        container.append(chips);
    }
    if (reviewing && ids.length < MAX_SELECTED) container.append(buildAddPicker(run));

    const actions = document.createElement('div');
    actions.className = 'world-sim-stepper-actions';
    if (reviewing) {
        const update = button('Update world', '', 'confirm-selection', 'fa-check');
        update.disabled = !ids.length;
        actions.append(update);
    }
    if (active && ['waiting-for-user', 'stalled', 'stopped', 'failed', 'selecting', 'updating'].includes(run.stage)) {
        actions.append(button('Show in chat', '', 'show-chat', 'fa-comments'));
    }
    if (active && run.detached) actions.append(button('Retry step', '', 'retry', 'fa-rotate-right'));
    if (active) actions.append(button('Abort run', 'menu_button_warning', 'abort', 'fa-ban'));
    if (!active && run.stage === 'committed' && run.revisionId) actions.append(button('Show on graph', '', 'show-graph', 'fa-diagram-project'));
    if (!active) actions.append(button('Dismiss', '', 'dismiss', 'fa-xmark'));
    if (!active || ['committed', 'failed', 'stopped'].includes(run.stage)) {
        const target = getReturnTarget();
        if (target) actions.append(button(`Back to “${target.name}”`, '', 'back', 'fa-arrow-left'));
    }
    if (actions.children.length) container.append(actions);
}

function buildAddPicker(run) {
    const wrapper = document.createElement('label');
    wrapper.className = 'world-sim-stepper-add';
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.dataset.stepperAdd = '1';
    select.setAttribute('aria-label', 'Add a character to this event');
    const placeholder = new Option('Add character…', '');
    select.append(placeholder);
    const chosen = new Set(run.characterIds || []);
    const excluded = new Set(run.excludedCharacterIds || []);
    for (const character of Object.values(getRoster().characters || {})) {
        if (!character.included || !character.initialized || chosen.has(character.id) || excluded.has(character.id)) continue;
        select.append(new Option(character.name || character.id, character.id));
    }
    wrapper.append(select);
    return wrapper;
}

function setSelection(ids) {
    updateRun({ characterIds: ids, selectorResult: { characterIds: ids } });
}

async function onClick(event) {
    const remove = event.target.closest('[data-remove-character]');
    if (remove) {
        const run = getRunState().run;
        setSelection((run?.characterIds || []).filter(id => id !== remove.dataset.removeCharacter));
        return;
    }
    const action = event.target.closest('[data-stepper-action]')?.dataset.stepperAction;
    if (!action) return;
    const { run } = getRunState();
    switch (action) {
        case 'confirm-selection': confirmSelection(); break;
        case 'retry': await retryRun(); break;
        case 'abort': abortRun(); break;
        case 'show-chat': await showRunInChat(); break;
        case 'show-graph': if (run?.revisionId) hooks.onShowOnGraph?.(run.revisionId); break;
        case 'dismiss': dismissedCycleId = run?.cycleId || null; renderRunStepper(); break;
        case 'back': await goBackToPreviousChat(); renderRunStepper(); break;
        default: break;
    }
}

export function bindRunStepperEvents(element) {
    element.addEventListener('click', event => void onClick(event));
    element.addEventListener('change', event => {
        const select = event.target.closest('[data-stepper-add]');
        if (!select || !select.value) return;
        const { run } = getRunState();
        const ids = [...(run?.characterIds || [])];
        if (!ids.includes(select.value) && ids.length < MAX_SELECTED) ids.push(select.value);
        setSelection(ids);
    });
}
