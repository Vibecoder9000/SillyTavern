import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';
import crypto from 'node:crypto';

export const router = express.Router();

const WORLD_SIM_DIR = 'world-sim';
const CHAT_FOLDERS = new Set(['selector-chats', 'updater-chats']);
const REVISION_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSION = 1;

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getWorldSimDir(directories) {
    return path.join(directories.root, WORLD_SIM_DIR);
}

/**
 * @param {string} dir
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {string} filePath
 * @param {any} data
 */
function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    writeFileAtomicSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {import('express').Request} request
 * @returns {string}
 */
function getBaseDir(request) {
    return getWorldSimDir(request.user.directories);
}

router.post('/load', (request, response) => {
    const baseDir = getBaseDir(request);
    ensureDir(baseDir);

    const config = readJson(path.join(baseDir, 'config.json'));
    const roster = mergeRoster(readJson(path.join(baseDir, 'roster.json')));
    const conversations = mergeConversations(readJson(path.join(baseDir, 'conversations.json')));

    const revision = ensureRevisionRoot(baseDir, roster);
    const eventHistory = ensureEventHistory(baseDir);

    return response.send({
        config: mergeConfig(config),
        roster,
        conversations,
        revisionIndex: revision.index,
        headSnapshot: revision.snapshot,
        eventHistory,
    });
});

router.post('/revisions/load', (request, response) => {
    const baseDir = getBaseDir(request);
    const current = ensureRevisionRoot(baseDir, mergeRoster(readJson(path.join(baseDir, 'roster.json'))));
    const revisionId = String(request.body?.revisionId || current.index.headId);
    const revision = current.index.revisions[revisionId];
    if (!revision) return response.status(404).send('Unknown revision');
    const snapshot = readJson(path.join(baseDir, 'revision-snapshots', revision.snapshotFilename));
    if (!snapshot) return response.status(500).send('Missing revision snapshot');
    return response.send({ index: current.index, revision, snapshot });
});

router.post('/revisions/commit', (request, response) => {
    const baseDir = getBaseDir(request);
    const current = ensureRevisionRoot(baseDir, mergeRoster(readJson(path.join(baseDir, 'roster.json'))));
    const { parentId, expectedHeadId, snapshot, metadata = {}, eventBatch, allowHistoricalParent = false } = request.body || {};
    if (!parentId || !expectedHeadId || !isValidSnapshot(snapshot)) return response.sendStatus(400);
    if (current.index.headId !== expectedHeadId) {
        return response.status(409).send({ error: 'stale_head', headId: current.index.headId });
    }
    if (!current.index.revisions[parentId]) return response.status(400).send({ error: 'unknown_parent' });
    if (!allowHistoricalParent && parentId !== current.index.headId) {
        return response.status(409).send({ error: 'parent_not_head', headId: current.index.headId });
    }

    const id = crypto.randomUUID();
    const snapshotFilename = `${id}.json`;
    const revision = normalizeRevisionMetadata({
        ...metadata,
        id,
        parentId,
        snapshotFilename,
        createdAt: new Date().toISOString(),
    });
    writeJson(path.join(baseDir, 'revision-snapshots', snapshotFilename), snapshot);
    const nextIndex = {
        schemaVersion: REVISION_SCHEMA_VERSION,
        headId: id,
        revisions: { ...current.index.revisions, [id]: revision },
    };
    writeJson(path.join(baseDir, 'revisions.json'), nextIndex);
    const eventHistory = eventBatch ? appendEventBatch(baseDir, withEventParent(
        ensureEventHistory(baseDir),
        current.index,
        parentId,
        {
            ...eventBatch,
            revisionId: id,
        },
    )) : ensureEventHistory(baseDir);
    return response.send({ index: nextIndex, revision, eventHistory });
});

router.post('/revisions/save-current', (request, response) => {
    const baseDir = getBaseDir(request);
    const current = ensureRevisionRoot(baseDir, mergeRoster(readJson(path.join(baseDir, 'roster.json'))));
    const { expectedHeadId, snapshot } = request.body || {};
    if (!expectedHeadId || !isValidSnapshot(snapshot)) return response.sendStatus(400);
    if (current.index.headId !== String(expectedHeadId)) {
        return response.status(409).send({ error: 'stale_head', headId: current.index.headId });
    }
    const head = current.index.revisions[current.index.headId];
    writeJson(path.join(baseDir, 'revision-snapshots', head.snapshotFilename), snapshot);
    return response.send({ headId: current.index.headId, snapshot });
});

router.post('/revisions/edit-location-bounds', (request, response) => {
    const baseDir = getBaseDir(request);
    const current = ensureRevisionRoot(baseDir, mergeRoster(readJson(path.join(baseDir, 'roster.json'))));
    const { revisionId, expectedSnapshotFilename, locationId, bounds } = request.body || {};
    if (!revisionId || !expectedSnapshotFilename || !locationId || !isValidLocationBounds(bounds)) {
        return response.sendStatus(400);
    }

    const selectedRevision = current.index.revisions[String(revisionId)];
    if (!selectedRevision) return response.status(404).send({ error: 'unknown_revision' });
    if (selectedRevision.snapshotFilename !== String(expectedSnapshotFilename)) {
        return response.status(409).send({ error: 'stale_revision', revision: selectedRevision });
    }

    const affectedIds = getRevisionDescendantIds(current.index, selectedRevision.id);
    const originalSnapshots = new Map();
    const staged = [];
    const nextSnapshots = new Map();
    try {
        for (const id of affectedIds) {
            const revision = current.index.revisions[id];
            const snapshot = readRevisionSnapshot(baseDir, revision);
            if (!snapshot) throw new Error(`Missing revision snapshot: ${id}`);
            originalSnapshots.set(id, snapshot);

            const location = snapshot.locations?.locations?.[String(locationId)];
            if (!location) continue;
            const nextSnapshot = applyLocationBoundsToSnapshot(snapshot, locationId, bounds);
            nextSnapshots.set(id, nextSnapshot);
        }

        if (!nextSnapshots.has(selectedRevision.id)) {
            return response.status(404).send({ error: 'unknown_location' });
        }

        const revisions = { ...current.index.revisions };
        for (const [id, snapshot] of nextSnapshots) {
            const oldRevision = current.index.revisions[id];
            const snapshotFilename = `${id}-${crypto.randomUUID()}.json`;
            writeJson(path.join(baseDir, 'revision-snapshots', snapshotFilename), snapshot);
            staged.push({ oldFilename: oldRevision.snapshotFilename, newFilename: snapshotFilename });
            revisions[id] = normalizeRevisionMetadata({ ...oldRevision, snapshotFilename });
        }

        const snapshotFor = id => nextSnapshots.get(id) || originalSnapshots.get(id) || readRevisionSnapshot(baseDir, revisions[id]);
        const metadataIds = new Set(affectedIds);
        for (const id of affectedIds) {
            for (const child of Object.values(revisions)) {
                if (child.parentId === id) metadataIds.add(child.id);
            }
        }
        for (const id of metadataIds) {
            const revision = revisions[id];
            if (!revision?.parentId) continue;
            const before = snapshotFor(revision.parentId);
            const after = snapshotFor(id);
            if (!before || !after) throw new Error(`Missing snapshot while updating revision metadata: ${id}`);
            revisions[id] = normalizeRevisionMetadata({ ...revision, ...diffWorldSnapshots(before, after) });
        }

        const nextIndex = { ...current.index, revisions };
        writeJson(path.join(baseDir, 'revisions.json'), nextIndex);
        for (const item of staged) {
            try {
                fs.rmSync(path.join(baseDir, 'revision-snapshots', item.oldFilename), { force: true });
            } catch (error) {
                console.warn('Failed to remove superseded World Sim revision snapshot:', error);
            }
        }
        const headSnapshot = nextSnapshots.get(nextIndex.headId) || current.snapshot;
        return response.send({ index: nextIndex, headSnapshot, affectedRevisionIds: [...nextSnapshots.keys()] });
    } catch (error) {
        for (const item of staged) {
            fs.rmSync(path.join(baseDir, 'revision-snapshots', item.newFilename), { force: true });
        }
        console.error('Failed to propagate World Sim location geometry:', error);
        return response.status(500).send({ error: 'location_geometry_edit_failed' });
    }
});

router.post('/revisions/edit', (request, response) => {
    const baseDir = getBaseDir(request);
    const current = ensureRevisionRoot(baseDir, mergeRoster(readJson(path.join(baseDir, 'roster.json'))));
    const { revisionId, expectedSnapshotFilename, snapshot } = request.body || {};
    if (!revisionId || !expectedSnapshotFilename || !isValidSnapshot(snapshot)) return response.sendStatus(400);

    const existingRevision = current.index.revisions[String(revisionId)];
    if (!existingRevision) return response.status(404).send({ error: 'unknown_revision' });
    if (existingRevision.snapshotFilename !== String(expectedSnapshotFilename)) {
        return response.status(409).send({
            error: 'stale_revision',
            revision: existingRevision,
        });
    }

    const newSnapshotFilename = `${existingRevision.id}-${crypto.randomUUID()}.json`;
    writeJson(path.join(baseDir, 'revision-snapshots', newSnapshotFilename), snapshot);

    try {
        const parentSnapshot = existingRevision.parentId
            ? readRevisionSnapshot(baseDir, current.index.revisions[existingRevision.parentId])
            : null;
        if (existingRevision.parentId && !parentSnapshot) throw new Error('Missing parent revision snapshot');

        const revisions = { ...current.index.revisions };
        revisions[existingRevision.id] = normalizeRevisionMetadata({
            ...existingRevision,
            ...(Object.hasOwn(request.body || {}, 'summary') ? { summary: request.body.summary } : {}),
            ...(parentSnapshot ? diffWorldSnapshots(parentSnapshot, snapshot) : emptySnapshotDiff()),
            snapshotFilename: newSnapshotFilename,
        });

        for (const child of Object.values(current.index.revisions)) {
            if (child.parentId !== existingRevision.id) continue;
            const childSnapshot = readRevisionSnapshot(baseDir, child);
            if (!childSnapshot) throw new Error(`Missing child revision snapshot: ${child.id}`);
            revisions[child.id] = normalizeRevisionMetadata({
                ...child,
                ...diffWorldSnapshots(snapshot, childSnapshot),
            });
        }

        const nextIndex = { ...current.index, revisions };
        writeJson(path.join(baseDir, 'revisions.json'), nextIndex);
        try {
            fs.rmSync(path.join(baseDir, 'revision-snapshots', existingRevision.snapshotFilename), { force: true });
        } catch (error) {
            console.warn('Failed to remove superseded World Sim revision snapshot:', error);
        }
        return response.send({ index: nextIndex, revision: revisions[existingRevision.id] });
    } catch (error) {
        fs.rmSync(path.join(baseDir, 'revision-snapshots', newSnapshotFilename), { force: true });
        console.error('Failed to edit World Sim revision:', error);
        return response.status(500).send({ error: 'revision_edit_failed' });
    }
});

router.post('/events/edit', (request, response) => {
    const baseDir = getBaseDir(request);
    const { eventId, characterId, summary } = request.body || {};
    if (!eventId || !characterId || typeof summary !== 'string') return response.sendStatus(400);
    const current = ensureEventHistory(baseDir);
    const existing = current.events[String(eventId)];
    if (!existing) return response.status(404).send({ error: 'unknown_event' });
    if (existing.kind === 'initialize' || !existing.characterIds.includes(String(characterId))) {
        return response.status(400).send({ error: 'summary_not_editable' });
    }

    const normalizedSummary = summary.trim() || null;
    const event = {
        ...existing,
        summaries: { ...existing.summaries, [String(characterId)]: normalizedSummary },
        editedAt: new Date().toISOString(),
    };
    const next = { ...current, events: { ...current.events, [event.id]: event } };
    writeJson(path.join(baseDir, 'events.json'), next);
    return response.send({ event, eventHistory: next });
});

router.post('/save', (request, response) => {
    const baseDir = getBaseDir(request);
    ensureDir(baseDir);

    if (request.body.config) writeJson(path.join(baseDir, 'config.json'), request.body.config);
    if (request.body.roster) writeJson(path.join(baseDir, 'roster.json'), mergeRoster(request.body.roster));
    if (request.body.conversations) writeJson(path.join(baseDir, 'conversations.json'), mergeConversations(request.body.conversations));

    return response.sendStatus(200);
});

router.post('/reset', (request, response) => {
    const baseDir = getBaseDir(request);

    try {
        fs.rmSync(baseDir, { recursive: true, force: true });
        ensureDir(baseDir);
        const roster = getDefaultRoster();
        const revision = ensureRevisionRoot(baseDir, roster);
        const eventHistory = ensureEventHistory(baseDir);
        return response.send({
            config: getDefaultConfig(),
            roster,
            conversations: getDefaultConversations(),
            revisionIndex: revision.index,
            headSnapshot: revision.snapshot,
            eventHistory,
        });
    } catch (error) {
        console.error('Failed to reset World Sim data:', error);
        return response.status(500).send('Failed to reset world-sim data');
    }
});

router.post('/chat/save', (request, response) => {
    const baseDir = getBaseDir(request);
    const { folder, id, messages } = request.body;
    if (!folder || !id || !Array.isArray(messages)) return response.sendStatus(400);
    if (!CHAT_FOLDERS.has(folder)) return response.sendStatus(400);

    const dir = path.join(baseDir, folder);
    ensureDir(dir);
    const filePath = path.join(dir, `${sanitize(String(id))}.jsonl`);
    const data = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    writeFileAtomicSync(filePath, data, 'utf8');
    return response.sendStatus(200);
});

router.post('/chat/load', (request, response) => {
    const baseDir = getBaseDir(request);
    const { folder, id } = request.body;
    if (!folder || !id) return response.sendStatus(400);
    if (!CHAT_FOLDERS.has(folder)) return response.sendStatus(400);

    const filePath = path.join(baseDir, folder, `${sanitize(String(id))}.jsonl`);
    if (!fs.existsSync(filePath)) return response.send([]);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const messages = lines.map(line => tryParse(line)).filter(Boolean);
    return response.send(messages);
});

router.post('/files/list', (request, response) => {
    const baseDir = getBaseDir(request);
    const { folder } = request.body;
    if (!folder) return response.sendStatus(400);
    if (!CHAT_FOLDERS.has(folder)) return response.sendStatus(400);

    const dir = path.join(baseDir, folder);
    ensureDir(dir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    return response.send(files);
});

function getDefaultConfig() {
    return {
        historyEntriesPerCharacter: 5,
        targetWordsPerEntry: 12,
        diceSides: 6,
        defaultLocation: 'everywhere',
        summaryPaused: false,
    };
}

function getDefaultRoster() {
    return { characters: {} };
}

function getDefaultLocations() {
    return { locations: {} };
}

function getDefaultState() {
    return {
        characters: {},
    };
}

function getDefaultConversations() {
    return [];
}

function getDefaultCharacterHistory() {
    return { location: [], activity: [], plan: [], summary: [] };
}

export function getDefaultEventHistory() {
    return { schemaVersion: EVENT_SCHEMA_VERSION, nextSequence: 1, events: {} };
}

function ensureEventHistory(baseDir) {
    const filePath = path.join(baseDir, 'events.json');
    const existing = readJson(filePath);
    if (existing?.schemaVersion === EVENT_SCHEMA_VERSION
        && existing.events && typeof existing.events === 'object' && !Array.isArray(existing.events)
        && Object.values(existing.events).every(event => event
            && Array.isArray(event.characterIds)
            && event.summaries && typeof event.summaries === 'object' && !Array.isArray(event.summaries))) {
        return existing;
    }
    const history = getDefaultEventHistory();
    writeJson(filePath, history);
    return history;
}

export function applyEventBatch(current, rawBatch, createId = () => crypto.randomUUID()) {
    const batch = rawBatch && typeof rawBatch === 'object' && !Array.isArray(rawBatch) ? rawBatch : {};
    const resetCharacterIds = [...new Set((Array.isArray(batch.resetCharacterIds) ? batch.resetCharacterIds : []).map(String))];
    const events = { ...current.events };

    const removedParents = new Map();
    for (const [eventId, event] of Object.entries(events)) {
        const characterIds = event.characterIds.filter(id => !resetCharacterIds.includes(id));
        if (!characterIds.length) {
            removedParents.set(eventId, event.parentId || null);
            delete events[eventId];
            continue;
        }
        if (characterIds.length !== event.characterIds.length) {
            events[eventId] = {
                ...event,
                characterIds,
                summaries: Object.fromEntries(characterIds.map(id => [id, event.summaries[id] ?? null])),
            };
        }
    }
    for (const [eventId, event] of Object.entries(events)) {
        let parentId = event.parentId;
        const seen = new Set();
        while (parentId && removedParents.has(parentId) && !seen.has(parentId)) {
            seen.add(parentId);
            parentId = removedParents.get(parentId);
        }
        if (parentId !== event.parentId) events[eventId] = { ...event, parentId: parentId || null };
    }

    const raw = batch.event && typeof batch.event === 'object' && !Array.isArray(batch.event) ? batch.event : null;
    const revisionId = batch.revisionId ? String(batch.revisionId) : null;
    let nextSequence = Math.max(1, Number(current.nextSequence) || 1);
    if (raw) {
        const rawSummaries = raw.summaries && typeof raw.summaries === 'object' && !Array.isArray(raw.summaries) ? raw.summaries : {};
        const characterIds = [...new Set((Array.isArray(raw.characterIds) ? raw.characterIds : Object.keys(rawSummaries)).map(String))]
            .filter(Boolean)
            .slice(0, 10);
        if (characterIds.length) {
            const id = createId();
            const kind = raw.kind === 'initialize' ? 'initialize' : 'event';
            const parentId = raw.parentId && events[String(raw.parentId)] ? String(raw.parentId) : null;
            const summaries = Object.fromEntries(characterIds.map(characterId => {
                const summary = typeof rawSummaries[characterId] === 'string' && rawSummaries[characterId].trim()
                    ? rawSummaries[characterId].trim()
                    : null;
                return [characterId, summary];
            }));
            const generation = normalizeEventGeneration(raw.generation);
            const event = {
                id,
                revisionId: raw.revisionId ? String(raw.revisionId) : revisionId,
                parentId,
                sequence: nextSequence++,
                kind,
                characterIds,
                summaries,
                ...(generation ? { generation } : {}),
            };
            events[id] = event;
        }
    }

    const next = { schemaVersion: EVENT_SCHEMA_VERSION, nextSequence, events };
    return next;
}

function normalizeEventGeneration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const guidance = typeof value.guidance === 'string' ? value.guidance.trim() : '';
    if (!guidance) return null;
    const normalizeIds = ids => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 10);
    return {
        guidance,
        includedCharacterIds: normalizeIds(value.includedCharacterIds),
        excludedCharacterIds: normalizeIds(value.excludedCharacterIds),
        exactCharacterSelection: !!value.exactCharacterSelection,
    };
}

function appendEventBatch(baseDir, rawBatch) {
    const next = applyEventBatch(ensureEventHistory(baseDir), rawBatch);
    writeJson(path.join(baseDir, 'events.json'), next);
    return next;
}

export function withEventParent(eventHistory, revisionIndex, parentRevisionId, rawBatch) {
    const batch = rawBatch && typeof rawBatch === 'object' && !Array.isArray(rawBatch) ? rawBatch : {};
    if (!batch.event || batch.event.parentId) return batch;

    const revisionAncestry = [];
    const seen = new Set();
    let revision = revisionIndex?.revisions?.[String(parentRevisionId)];
    while (revision && !seen.has(revision.id)) {
        seen.add(revision.id);
        revisionAncestry.push(revision.id);
        revision = revision.parentId ? revisionIndex.revisions[revision.parentId] : null;
    }

    const eventsByRevision = new Map();
    for (const event of Object.values(eventHistory?.events || {})) {
        if (!event.revisionId) continue;
        const existing = eventsByRevision.get(event.revisionId);
        if (!existing || Number(event.sequence) > Number(existing.sequence)) {
            eventsByRevision.set(event.revisionId, event);
        }
    }

    const parent = revisionAncestry.map(revisionId => eventsByRevision.get(revisionId)).find(Boolean);
    return {
        ...batch,
        event: parent ? { ...batch.event, parentId: parent.id } : batch.event,
    };
}

function captureInitialSnapshot(roster) {
    const characterRevisions = {};
    for (const id of Object.keys(roster.characters)) {
        characterRevisions[id] = { initialized: false, history: getDefaultCharacterHistory() };
    }
    return {
        schemaVersion: REVISION_SCHEMA_VERSION,
        state: getDefaultState(),
        locations: getDefaultLocations(),
        characters: characterRevisions,
    };
}

function isValidSnapshot(snapshot) {
    return snapshot
        && snapshot.schemaVersion === REVISION_SCHEMA_VERSION
        && snapshot.state && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)
        && !Object.hasOwn(snapshot.state, 'scenes')
        && snapshot.locations && typeof snapshot.locations === 'object' && !Array.isArray(snapshot.locations)
        && snapshot.characters && typeof snapshot.characters === 'object' && !Array.isArray(snapshot.characters);
}

function isValidLocationBounds(bounds) {
    const { left, right, bottom, top } = normalizeLocationBounds(bounds);
    return [left, right, bottom, top].every(Number.isFinite) && right > left && top > bottom;
}

function normalizeLocationBounds(bounds) {
    return {
        left: Number(bounds?.left),
        right: Number(bounds?.right),
        bottom: Number(bounds?.bottom),
        top: Number(bounds?.top),
    };
}

export function applyLocationBoundsToSnapshot(snapshot, locationId, bounds) {
    if (!isValidSnapshot(snapshot) || !locationId || !isValidLocationBounds(bounds)) {
        throw new Error('Invalid World Sim location geometry edit');
    }
    const nextSnapshot = structuredClone(snapshot);
    const location = nextSnapshot.locations?.locations?.[String(locationId)];
    if (!location) return null;
    Object.assign(location, normalizeLocationBounds(bounds));
    delete location.x;
    delete location.y;
    delete location.w;
    delete location.h;
    return nextSnapshot;
}

function getRevisionDescendantIds(index, rootId) {
    const children = new Map();
    for (const revision of Object.values(index?.revisions || {})) {
        if (!revision.parentId) continue;
        if (!children.has(revision.parentId)) children.set(revision.parentId, []);
        children.get(revision.parentId).push(revision.id);
    }
    const result = [];
    const queue = [String(rootId)];
    const seen = new Set();
    while (queue.length) {
        const id = queue.shift();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
        queue.push(...(children.get(id) || []));
    }
    return result;
}

function normalizeRevisionMetadata(value) {
    return {
        id: String(value.id),
        parentId: value.parentId ? String(value.parentId) : null,
        source: String(value.source || 'manual'),
        summary: String(value.summary || 'World state changed'),
        createdAt: String(value.createdAt || new Date().toISOString()),
        affectedCharacters: Array.isArray(value.affectedCharacters) ? [...new Set(value.affectedCharacters.map(String))] : [],
        characterChanges: value.characterChanges && typeof value.characterChanges === 'object' ? value.characterChanges : {},
        sharedWorldChanges: Array.isArray(value.sharedWorldChanges) ? value.sharedWorldChanges.map(String) : [],
        generation: value.generation && typeof value.generation === 'object' ? value.generation : undefined,
        snapshotFilename: String(value.snapshotFilename),
    };
}

function ensureRevisionRoot(baseDir, roster) {
    const indexPath = path.join(baseDir, 'revisions.json');
    const existing = readJson(indexPath);
    if (existing?.schemaVersion === REVISION_SCHEMA_VERSION && existing?.headId && existing?.revisions?.[existing.headId]) {
        const head = existing.revisions[existing.headId];
        const snapshot = readJson(path.join(baseDir, 'revision-snapshots', head.snapshotFilename));
        if (isValidSnapshot(snapshot)) return { index: existing, snapshot };
    }

    // Revision history predating the current schema was temporary. Do not migrate it or
    // leave its legacy cycle/snapshot stores available as an alternate source of truth.
    fs.rmSync(path.join(baseDir, 'revision-snapshots'), { recursive: true, force: true });
    fs.rmSync(path.join(baseDir, 'snapshots'), { recursive: true, force: true });
    fs.rmSync(path.join(baseDir, 'cycles.jsonl'), { force: true });

    const id = crypto.randomUUID();
    const snapshotFilename = `${id}.json`;
    const snapshot = captureInitialSnapshot(roster);
    const revision = normalizeRevisionMetadata({
        id,
        parentId: null,
        source: 'root',
        summary: 'Current world',
        affectedCharacters: Object.keys(snapshot.characters),
        sharedWorldChanges: [],
        snapshotFilename,
    });
    const index = { schemaVersion: REVISION_SCHEMA_VERSION, headId: id, revisions: { [id]: revision } };
    writeJson(path.join(baseDir, 'revision-snapshots', snapshotFilename), snapshot);
    writeJson(indexPath, index);
    return { index, snapshot };
}

/**
 * @param {any} value
 * @returns {object}
 */
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * @param {any} value
 * @returns {object}
 */
function mergeConfig(value) {
    return { ...getDefaultConfig(), ...asObject(value) };
}

/**
 * @param {any} value
 * @returns {{ characters: object }}
 */
function mergeRoster(value) {
    const next = asObject(value);
    const characters = {};
    for (const [id, rawCharacter] of Object.entries(asObject(next.characters))) {
        const source = asObject(rawCharacter);
        const character = {};
        for (const key of ['id', 'name', 'avatar', 'included', 'priority', 'cardContext']) {
            if (Object.hasOwn(source, key)) character[key] = source[key];
        }
        characters[id] = character;
    }
    return {
        ...getDefaultRoster(),
        ...next,
        characters,
    };
}

/**
 * @param {any} value
 * @returns {object[]}
 */
function mergeConversations(value) {
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object').map(item => ({ ...item })) : getDefaultConversations();
}

function readRevisionSnapshot(baseDir, revision) {
    if (!revision?.snapshotFilename) return null;
    const snapshot = readJson(path.join(baseDir, 'revision-snapshots', revision.snapshotFilename));
    return isValidSnapshot(snapshot) ? snapshot : null;
}

function diffWorldSnapshots(before, after) {
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
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
        affectedCharacters.push(id);
        characterChanges[id] = buildFieldDiff(oldValue.state || {}, newValue.state || {});
    }
    const sharedWorldChanges = [];
    if (JSON.stringify(before?.locations) !== JSON.stringify(after?.locations)) sharedWorldChanges.push('Locations changed');
    return { affectedCharacters, characterChanges, sharedWorldChanges };
}

function emptySnapshotDiff() {
    return { affectedCharacters: [], characterChanges: {}, sharedWorldChanges: [] };
}

function buildFieldDiff(before, after) {
    const result = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            result[key] = { before: before[key], after: after[key] };
        }
    }
    return result;
}
