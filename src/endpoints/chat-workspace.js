import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const CHAT_WORKSPACE_FILE = 'chat-workspace.json';
export const CHAT_WORKSPACE_VERSION = 1;
export const MAX_WORKSPACE_TABS = 200;

/**
 * Selects the document served at the public root without changing the visible URL.
 * Workspace children identify themselves with an internal query parameter so they
 * receive the existing SillyTavern application instead of recursively loading the shell.
 * @param {import('express').Request} request Express request
 * @returns {'index.html'|'chat-workspace.html'} Root document
 */
export function getChatWorkspaceRootDocument(request) {
    return request.query.workspaceRuntime
        ? 'index.html'
        : 'chat-workspace.html';
}

function getWorkspacePath(directories) {
    return path.join(directories.root, CHAT_WORKSPACE_FILE);
}

/**
 * Validates the small, user-owned workspace document before it is written.
 * @param {unknown} value Workspace document
 * @returns {object|null} Valid workspace document or null
 */
export function validateWorkspaceState(value) {
    if (!value || typeof value !== 'object' || value.version !== CHAT_WORKSPACE_VERSION || !Array.isArray(value.tabs)) {
        return null;
    }

    if (value.tabs.length > MAX_WORKSPACE_TABS) {
        return null;
    }

    return value;
}

export const router = express.Router();

router.get('/state', (request, response) => {
    const workspacePath = getWorkspacePath(request.user.directories);
    if (!fs.existsSync(workspacePath)) return response.json({ workspace: null });
    try {
        const workspace = validateWorkspaceState(JSON.parse(fs.readFileSync(workspacePath, 'utf8')));
        return response.json({ workspace });
    } catch (error) {
        console.warn(`Could not read chat workspace state from ${workspacePath}:`, error);
        return response.json({ workspace: null });
    }
});

router.get('/client-error', (request, response) => {
    const clean = value => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
    const stage = clean(request.query.stage) || 'unknown stage';
    const message = clean(request.query.message) || 'unknown error';
    console.error(`[Chat Workspace] Client initialization failed from ${request.ip} during ${stage}: ${message}`);
    return response.sendStatus(204);
});

router.post('/state', (request, response) => {
    const workspace = validateWorkspaceState(request.body);
    if (!workspace) {
        return response.status(400).send({ error: 'Invalid chat workspace state' });
    }

    try {
        const workspacePath = getWorkspacePath(request.user.directories);
        writeFileAtomicSync(workspacePath, JSON.stringify(workspace, null, 4), 'utf8');
        return response.json({ ok: true });
    } catch (error) {
        console.error('Could not save chat workspace state:', error);
        return response.status(500).send({ error: 'Could not save chat workspace state' });
    }
});
