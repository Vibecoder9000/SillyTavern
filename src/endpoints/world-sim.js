import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';

export const router = express.Router();

const WORLD_SIM_DIR = 'world-sim';
const CHAT_FOLDERS = new Set(['selector-chats', 'updater-chats']);

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
    const roster = readJson(path.join(baseDir, 'roster.json'));
    const locations = readJson(path.join(baseDir, 'locations.json'));
    const state = readJson(path.join(baseDir, 'state.json'));

    return response.send({
        config: mergeConfig(config),
        roster: mergeRoster(roster),
        locations: mergeLocations(locations),
        state: mergeState(state),
    });
});

router.post('/save', (request, response) => {
    const baseDir = getBaseDir(request);
    ensureDir(baseDir);

    if (request.body.config) writeJson(path.join(baseDir, 'config.json'), request.body.config);
    if (request.body.roster) writeJson(path.join(baseDir, 'roster.json'), request.body.roster);
    if (request.body.locations) writeJson(path.join(baseDir, 'locations.json'), request.body.locations);
    if (request.body.state) writeJson(path.join(baseDir, 'state.json'), request.body.state);

    return response.sendStatus(200);
});

router.post('/reset', (request, response) => {
    const baseDir = getBaseDir(request);

    try {
        fs.rmSync(baseDir, { recursive: true, force: true });
        ensureDir(baseDir);
        return response.send({
            config: getDefaultConfig(),
            roster: getDefaultRoster(),
            locations: getDefaultLocations(),
            state: getDefaultState(),
        });
    } catch (error) {
        console.error('Failed to reset World Sim data:', error);
        return response.status(500).send('Failed to reset world-sim data');
    }
});

router.post('/cycles', (request, response) => {
    const baseDir = getBaseDir(request);
    const cyclesPath = path.join(baseDir, 'cycles.jsonl');
    ensureDir(baseDir);

    if (request.body.append) {
        const line = JSON.stringify(request.body.append) + '\n';
        fs.appendFileSync(cyclesPath, line, 'utf8');
        return response.sendStatus(200);
    }

    if (!fs.existsSync(cyclesPath)) return response.send([]);
    const lines = fs.readFileSync(cyclesPath, 'utf8').split('\n').filter(Boolean);
    const cycles = lines.map(line => tryParse(line)).filter(Boolean);
    return response.send(cycles);
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

router.post('/snapshot/save', (request, response) => {
    const baseDir = getBaseDir(request);
    const { cycleId, snapshot } = request.body;
    if (!cycleId || !snapshot) return response.sendStatus(400);

    const dir = path.join(baseDir, 'snapshots');
    ensureDir(dir);
    const filePath = path.join(dir, `${sanitize(String(cycleId))}.json`);
    writeJson(filePath, snapshot);
    return response.sendStatus(200);
});

router.post('/snapshot/load', (request, response) => {
    const baseDir = getBaseDir(request);
    const { cycleId } = request.body;
    if (!cycleId) return response.sendStatus(400);

    const filePath = path.join(baseDir, 'snapshots', `${sanitize(String(cycleId))}.json`);
    const snapshot = readJson(filePath);
    return response.send(snapshot ?? {});
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
        tickIntervalMinutes: 10,
        autoPauseIdleMinutes: 60,
        historyEntriesPerCharacter: 5,
        targetWordsPerEntry: 12,
        diceSides: 6,
        defaultLocation: 'everywhere',
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
        tick: 0,
        inWorldMinutes: 0,
        lastRunAt: null,
        nextTickAt: null,
        paused: true,
        idlePaused: false,
        characters: {},
    };
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
    return {
        ...getDefaultRoster(),
        ...next,
        characters: asObject(next.characters),
    };
}

/**
 * @param {any} value
 * @returns {{ locations: object }}
 */
function mergeLocations(value) {
    const next = asObject(value);
    return {
        ...getDefaultLocations(),
        ...next,
        locations: asObject(next.locations),
    };
}

/**
 * @param {any} value
 * @returns {object}
 */
function mergeState(value) {
    const next = asObject(value);
    return {
        ...getDefaultState(),
        ...next,
        characters: asObject(next.characters),
    };
}
