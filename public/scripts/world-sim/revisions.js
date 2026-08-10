import { getRequestHeaders } from '../../script.js';
import { initializeEventHistory } from './event-history.js';

const API_URL = '/api/world-sim';
const SNAPSHOT_SCHEMA_VERSION = 1;

let index = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, headId: null, revisions: {} };
let headSnapshot = null;

const clone = value => JSON.parse(JSON.stringify(value));

export function initializeRevisions(nextIndex, snapshot) {
    index = nextIndex || { schemaVersion: SNAPSHOT_SCHEMA_VERSION, headId: null, revisions: {} };
    headSnapshot = snapshot ? clone(snapshot) : null;
}

export function getRevisionIndex() {
    return index;
}

export function getHeadRevisionId() {
    return index?.headId || null;
}

export function getHeadSnapshot() {
    return headSnapshot ? clone(headSnapshot) : null;
}

export function captureWorldSnapshot(roster, locations, state) {
    const snapshotState = clone(state || {});
    const characters = {};
    for (const [id, character] of Object.entries(roster?.characters || {})) {
        characters[id] = {
            initialized: !!character.initialized,
            history: clone(character.history || { location: [], activity: [], plan: [], summary: [] }),
        };
    }
    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        state: snapshotState,
        locations: clone(locations || { locations: {} }),
        characters,
    };
}

export function hydrateWorldSnapshot(snapshot, roster, locations, state) {
    if (!isValidWorldSnapshot(snapshot)) throw new Error('Invalid World Sim revision snapshot');
    const nextState = clone(snapshot.state);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, nextState);

    for (const key of Object.keys(locations)) delete locations[key];
    Object.assign(locations, clone(snapshot.locations));

    for (const [id, character] of Object.entries(roster?.characters || {})) {
        const persistent = {};
        for (const key of ['id', 'name', 'avatar', 'included', 'priority', 'cardContext']) {
            if (Object.hasOwn(character, key)) persistent[key] = clone(character[key]);
        }
        const saved = snapshot.characters?.[id];
        for (const key of Object.keys(character)) delete character[key];
        Object.assign(character, persistent, saved ? clone(saved) : {
            initialized: false,
            history: { location: [], activity: [], plan: [], summary: [] },
        });
    }
}

export function diffWorldSnapshots(before, after) {
    const ids = new Set([
        ...Object.keys(before?.state?.characters || {}),
        ...Object.keys(after?.state?.characters || {}),
        ...Object.keys(before?.characters || {}),
        ...Object.keys(after?.characters || {}),
    ]);
    const characterChanges = {};
    const affectedCharacters = [];
    for (const id of ids) {
        const oldValue = { state: before?.state?.characters?.[id], revision: before?.characters?.[id] };
        const newValue = { state: after?.state?.characters?.[id], revision: after?.characters?.[id] };
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            affectedCharacters.push(id);
            characterChanges[id] = buildFieldDiff(oldValue.state || {}, newValue.state || {});
        }
    }
    const sharedWorldChanges = [];
    if (JSON.stringify(before?.locations) !== JSON.stringify(after?.locations)) sharedWorldChanges.push('Locations changed');
    return { affectedCharacters, characterChanges, sharedWorldChanges };
}

function buildFieldDiff(before, after) {
    const result = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) result[key] = { before: before[key], after: after[key] };
    }
    return result;
}

export async function loadRevisionSnapshot(revisionId) {
    const response = await fetch(`${API_URL}/revisions/load`, {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ revisionId }),
    });
    if (!response.ok) throw new Error('Failed to load World Sim revision');
    const data = await response.json();
    index = data.index;
    return clone(data.snapshot);
}

export async function commitRevision({ parentId, expectedHeadId, snapshot, metadata, eventBatch, allowHistoricalParent = false }) {
    if (!isValidWorldSnapshot(snapshot)) throw new Error('Invalid World Sim revision snapshot');
    const response = await fetch(`${API_URL}/revisions/commit`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ parentId, expectedHeadId, snapshot, metadata, eventBatch, allowHistoricalParent }),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(response.status === 409 ? 'The world changed before this revision could be committed.' : 'Failed to commit World Sim revision');
        error.code = detail.error || `http_${response.status}`;
        error.headId = detail.headId;
        throw error;
    }
    const data = await response.json();
    index = data.index;
    headSnapshot = clone(snapshot);
    initializeEventHistory(data.eventHistory);
    return data.revision;
}

export async function saveCurrentSnapshot(snapshot) {
    if (!isValidWorldSnapshot(snapshot) || !index?.headId) throw new Error('Invalid current World Sim snapshot');
    const response = await fetch(`${API_URL}/revisions/save-current`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ expectedHeadId: index.headId, snapshot }),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(response.status === 409 ? 'The world changed before the map could be saved.' : 'Failed to save current World Sim state');
        error.code = detail.error || `http_${response.status}`;
        error.headId = detail.headId;
        throw error;
    }
    headSnapshot = clone(snapshot);
}

export async function propagateLocationBounds({ revisionId, expectedSnapshotFilename, locationId, bounds }) {
    if (!revisionId || !expectedSnapshotFilename || !locationId || !isValidLocationBounds(bounds)) {
        throw new Error('Invalid World Sim location geometry edit');
    }
    const response = await fetch(`${API_URL}/revisions/edit-location-bounds`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ revisionId, expectedSnapshotFilename, locationId, bounds }),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.error === 'stale_revision'
            ? 'This revision changed after it was loaded.'
            : 'Failed to save World Sim location geometry');
        error.code = detail.error || `http_${response.status}`;
        error.revision = detail.revision;
        throw error;
    }
    const data = await response.json();
    index = data.index;
    if (data.headSnapshot) headSnapshot = clone(data.headSnapshot);
    return data;
}

export async function editRevision({ revisionId, expectedSnapshotFilename, snapshot, summary }) {
    if (!revisionId || !expectedSnapshotFilename || !isValidWorldSnapshot(snapshot)) {
        throw new Error('Invalid World Sim revision edit');
    }
    const body = { revisionId, expectedSnapshotFilename, snapshot };
    if (summary !== undefined) body.summary = summary;
    const response = await fetch(`${API_URL}/revisions/edit`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.error === 'stale_revision'
            ? 'This revision changed after it was loaded.'
            : 'Failed to edit World Sim revision');
        error.code = detail.error || `http_${response.status}`;
        error.revision = detail.revision;
        throw error;
    }
    const data = await response.json();
    index = data.index;
    if (revisionId === index.headId) headSnapshot = clone(snapshot);
    return data.revision;
}

export function isValidWorldSnapshot(snapshot) {
    return snapshot?.schemaVersion === SNAPSHOT_SCHEMA_VERSION
        && snapshot.state && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)
        && !Object.hasOwn(snapshot.state, 'scenes')
        && snapshot.locations && typeof snapshot.locations === 'object' && !Array.isArray(snapshot.locations)
        && snapshot.characters && typeof snapshot.characters === 'object' && !Array.isArray(snapshot.characters);
}

function isValidLocationBounds(bounds) {
    const left = Number(bounds?.left);
    const right = Number(bounds?.right);
    const bottom = Number(bounds?.bottom);
    const top = Number(bounds?.top);
    return [left, right, bottom, top].every(Number.isFinite) && right > left && top > bottom;
}
