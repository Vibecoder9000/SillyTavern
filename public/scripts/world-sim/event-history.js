import { getRequestHeaders } from '../../script.js';

export const EVENT_HISTORY_SCHEMA_VERSION = 1;

const API_URL = '/api/world-sim';

export const HISTORY_NODE_WIDTH = 210;
export const HISTORY_NODE_HEIGHT = 90;
export const HISTORY_SHARED_NODE_HEIGHT = 138;
export const HISTORY_COLUMN_STEP = 310;
export const HISTORY_LANE_STEP = 210;
export const HISTORY_ORBIT_RADIUS = 250;

let history = createEmptyEventHistory();

export function createEmptyEventHistory() {
    return { schemaVersion: EVENT_HISTORY_SCHEMA_VERSION, nextSequence: 1, events: {} };
}

export function initializeEventHistory(value) {
    history = isEventHistory(value) ? value : createEmptyEventHistory();
}

export function getEventHistory() {
    return history;
}

export async function editEventSummary(eventId, characterId, summary) {
    const response = await fetch(`${API_URL}/events/edit`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ eventId, characterId, summary }),
    });
    if (!response.ok) throw new Error('Failed to edit World Sim event');
    const data = await response.json();
    initializeEventHistory(data.eventHistory);
    return data.event;
}

export function getEventChildren(eventHistory = history) {
    const children = new Map();
    for (const event of Object.values(eventHistory?.events || {})) {
        if (!children.has(event.parentId)) children.set(event.parentId, []);
        children.get(event.parentId).push(event);
    }
    for (const list of children.values()) {
        list.sort((a, b) => Number(b.sequence) - Number(a.sequence) || String(a.id).localeCompare(String(b.id)));
    }
    return children;
}

export function getEventAncestors(eventId, eventHistory = history) {
    const result = [];
    const seen = new Set();
    let event = eventHistory?.events?.[eventId];
    while (event && !seen.has(event.id)) {
        seen.add(event.id);
        result.unshift(event);
        event = event.parentId ? eventHistory.events[event.parentId] : null;
    }
    return result;
}

export function formatParticipantNames(names) {
    const clean = names.map(String).map(name => name.trim()).filter(Boolean);
    if (!clean.length) return '';
    if (clean.length === 1) return `with ${clean[0]}`;
    if (clean.length === 2) return `with ${clean[0]} and ${clean[1]}`;
    return `with ${clean.slice(0, -1).join(', ')}, and ${clean.at(-1)}`;
}

export function getEventSummaryText(event) {
    return !event?.summary ? '<no summary>' : String(event.summary);
}

/**
 * Expands each stored logical event into one display node per character summary.
 * These character nodes exist only for the timeline; persistence keeps one event.
 * @param {object} eventHistory
 * @returns {object}
 */
export function createDisplayEventHistory(eventHistory) {
    const logicalEvents = eventHistory?.events || {};
    const events = {};
    const projectionId = (eventId, characterId) => `${eventId}:${encodeURIComponent(characterId)}`;

    for (const logicalEvent of Object.values(logicalEvents)) {
        for (const characterId of logicalEvent.characterIds || []) {
            const id = projectionId(logicalEvent.id, characterId);
            const parent = findCharacterParent(logicalEvent, characterId, logicalEvents);
            const participants = (logicalEvent.characterIds || [])
                .filter(id => id !== characterId)
                .map(id => ({ characterId: id, eventId: projectionId(logicalEvent.id, id) }));
            events[id] = {
                id,
                logicalEventId: logicalEvent.id,
                revisionId: logicalEvent.revisionId,
                parentId: parent ? projectionId(parent.id, characterId) : null,
                characterId,
                sequence: logicalEvent.sequence,
                kind: logicalEvent.kind,
                summary: logicalEvent.summaries?.[characterId] || null,
                generation: logicalEvent.generation || null,
                participants,
            };
        }
    }

    return { schemaVersion: EVENT_HISTORY_SCHEMA_VERSION, nextSequence: eventHistory?.nextSequence || 1, events };
}

function findCharacterParent(event, characterId, events) {
    const seen = new Set();
    let parent = event.parentId ? events[event.parentId] : null;
    while (parent && !seen.has(parent.id)) {
        if ((parent.characterIds || []).includes(characterId)) return parent;
        seen.add(parent.id);
        parent = parent.parentId ? events[parent.parentId] : null;
    }
    return null;
}

function isEventHistory(value) {
    if (value?.schemaVersion !== EVENT_HISTORY_SCHEMA_VERSION
        || !value.events || typeof value.events !== 'object' || Array.isArray(value.events)) return false;
    return Object.values(value.events).every(event => event
        && Array.isArray(event.characterIds)
        && event.summaries && typeof event.summaries === 'object' && !Array.isArray(event.summaries));
}

export function calculateOrbitPositions(events, rotationIndex = 0, radius = HISTORY_ORBIT_RADIUS) {
    if (!events.length) return [];
    const selected = Math.max(0, Math.min(events.length - 1, rotationIndex));
    const visibleSlots = 6;
    const step = events.length === 1 ? 0 : (Math.PI * 2) / Math.min(events.length, visibleSlots);
    return events.map((event, index) => {
        const relative = index - selected;
        const piled = events.length > visibleSlots && (relative < 0 || relative >= visibleSlots);
        const angle = piled ? -Math.PI / 2 : relative * step;
        const pileOffset = piled ? Math.min(24, Math.abs(relative) * 3) : 0;
        return {
            event,
            angle,
            piled,
            x: Math.cos(angle) * radius + pileOffset,
            y: Math.sin(angle) * radius + pileOffset * 0.35,
        };
    });
}

/**
 * Produces the compact base timeline. Traversal stops at the first branching parent;
 * descendants are exposed through the circular interaction instead.
 */
export function layoutEventHistory(eventHistory, characterIds) {
    const children = getEventChildren(eventHistory);
    const nodes = [];
    const edges = [];
    const positions = new Map();
    const laneIds = characterIds.filter(id => Object.values(eventHistory?.events || {}).some(event => event.characterId === id));

    laneIds.forEach((characterId, laneIndex) => {
        const roots = (children.get(null) || []).filter(event => event.characterId === characterId)
            .sort((a, b) => Number(a.sequence) - Number(b.sequence));
        let event = roots[0];
        let depth = 0;
        while (event) {
            const position = { x: depth * HISTORY_COLUMN_STEP, y: laneIndex * HISTORY_LANE_STEP };
            nodes.push({ type: 'event', event, characterId, ...position });
            positions.set(event.id, position);
            if (event.parentId && positions.has(event.parentId)) edges.push({ parentId: event.parentId, childId: event.id });
            const next = (children.get(event.id) || []).filter(child => child.characterId === characterId);
            if (next.length > 1) {
                const aggregateId = `aggregate:${event.id}`;
                const aggregatePosition = { x: (depth + 1) * HISTORY_COLUMN_STEP, y: laneIndex * HISTORY_LANE_STEP };
                nodes.push({ type: 'aggregate', id: aggregateId, parentId: event.id, childIds: next.map(child => child.id), count: next.length, characterId, ...aggregatePosition });
                positions.set(aggregateId, aggregatePosition);
                edges.push({ parentId: event.id, childId: aggregateId });
                break;
            }
            if (!next.length) break;
            event = next[0];
            depth++;
        }
    });

    return { nodes, edges, positions, laneIds, children };
}
