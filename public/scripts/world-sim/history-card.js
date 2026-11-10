// The event card shown when a node in the history graph is clicked: full summary,
// participants, guidance, what changed, and the actions for that event.

import { getThumbnailUrl } from '../../script.js';
import { editEventSummary, getEventHistory, getEventSummaryText } from './event-history.js';
import { promptWorldSimText } from './popups.js';

function actionButton(label, icon, handler, { disabled = false, title = '' } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.disabled = disabled;
    if (title) button.title = title;
    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
    button.querySelector('span').textContent = label;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await handler();
        } catch (error) {
            console.error(error);
            toastr.error(error.message, 'World Sim');
        } finally {
            if (button.isConnected) button.disabled = disabled;
        }
    });
    return button;
}

function section(title, ...children) {
    const wrapper = document.createElement('div');
    wrapper.className = 'world-sim-history-card-section';
    const label = document.createElement('strong');
    label.textContent = title;
    wrapper.append(label, ...children);
    return wrapper;
}

function textBlock(text) {
    const block = document.createElement('div');
    block.textContent = text;
    return block;
}

/** Plain-language lines describing what this event changed for its character. */
function describeChanges(revision, characterId) {
    const fields = revision?.characterChanges?.[characterId];
    if (!fields) return [];
    return Object.entries(fields).map(([field, values]) => `${field}: ${String(values?.before ?? '—')} → ${String(values?.after ?? '—')}`);
}

/**
 * @param {object} args
 * @param {object} args.event  Display event (see createDisplayEventHistory).
 * @param {object} args.history Display history.
 * @param {object} args.roster
 * @param {object} args.options Timeline options (onOpenScene, getScene, onCommitScene, onCreateOption, onShowOnMap, onDetails, getRevision).
 * @param {() => void} args.rerender Re-renders the whole timeline (after an edit).
 * @returns {HTMLElement}
 */
export function createEventCard({ event, history, roster, options, rerender }) {
    const card = document.createElement('div');
    card.className = 'world-sim-history-dropdown world-sim-history-card';
    card.dataset.eventMenu = event.id;
    card.setAttribute('role', 'dialog');
    const character = roster.characters?.[event.characterId];
    card.setAttribute('aria-label', `Event for ${character?.name || event.characterId}`);

    const head = document.createElement('div');
    head.className = 'world-sim-history-card-head';
    if (character?.avatar) {
        const avatar = document.createElement('img');
        avatar.alt = '';
        avatar.src = getThumbnailUrl('avatar', character.avatar);
        head.append(avatar);
    }
    const title = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = character?.name || event.characterId;
    const kind = document.createElement('small');
    kind.textContent = event.kind === 'initialize' ? 'Initialized' : `Event ${event.sequence ?? ''}`.trim();
    title.append(name, kind);
    head.append(title);
    card.append(head);

    if (event.kind !== 'initialize') {
        card.append(section('Summary', textBlock(getEventSummaryText(event))));
    }

    const others = (event.participants || [])
        .map(link => roster.characters?.[link.characterId]?.name || link.characterId);
    if (others.length) card.append(section('With', textBlock(others.join(', '))));

    if (event.generation?.guidance) card.append(section('Guidance', textBlock(event.generation.guidance)));

    const revision = event.revisionId ? options.getRevision?.(event.revisionId) : null;
    const changes = describeChanges(revision, event.characterId);
    if (changes.length) {
        const list = document.createElement('pre');
        list.className = 'world-sim-history-card-changes';
        list.textContent = changes.join('\n');
        card.append(section('What changed', list));
    }

    const actions = document.createElement('div');
    actions.className = 'world-sim-history-card-actions';
    const canAct = !!event.revisionId;

    if (canAct && typeof options.onOpenScene === 'function') {
        const existing = options.getScene?.(event);
        actions.append(actionButton(existing ? 'Reopen scene' : 'Open scene', 'fa-comments', () => options.onOpenScene(event)));
        if (existing && !existing.committed && typeof options.onCommitScene === 'function') {
            actions.append(actionButton('Commit scene to world', 'fa-down-left-and-up-right-to-center', () => options.onCommitScene(event, existing)));
        }
    }
    actions.append(actionButton('Branch from here', 'fa-code-branch', () => options.onCreateOption?.(event), {
        disabled: !canAct || typeof options.onCreateOption !== 'function',
        title: 'Start an alternate path from this event',
    }));
    if (event.kind !== 'initialize') {
        actions.append(actionButton('Edit summary', 'fa-pen-to-square', async () => {
            const current = history.events[event.id] || event;
            const summary = await promptWorldSimText({
                title: 'Edit event summary',
                message: 'Change the short description shown on the World Sim timeline.',
                value: current.summary || '',
                confirmLabel: 'Save summary',
                icon: 'fa-pen-to-square',
                placeholder: 'What happened in this event?',
                rows: 3,
                maxLength: 500,
            });
            if (summary === null || summary === current.summary) return;
            await editEventSummary(current.logicalEventId, current.characterId, summary);
            rerender(getEventHistory());
        }));
    }
    if (typeof options.onShowOnMap === 'function') {
        actions.append(actionButton('Show on map', 'fa-map-location-dot', () => options.onShowOnMap(event)));
    }
    if (canAct && typeof options.onDetails === 'function') {
        actions.append(actionButton('Details', 'fa-list', () => options.onDetails(event)));
    }
    card.append(actions);
    return card;
}
