import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import sanitize from 'sanitize-filename';
import { writeFileAtomicSyncWithRetry } from '../atomic-write.js';

const AVATAR_FILE_PATTERN = /^[^/\\]+\.png$/i;
// This is intentionally a server-owned resource: the model receives selected
// words, never a filesystem path or direct access to the source list.
const KEYWORDS_PATH = fileURLToPath(new URL('../character-designer/keywords.txt', import.meta.url));

function getWorkspaceFilePath(directories, avatarUrl) {
    if (typeof avatarUrl !== 'string' || !AVATAR_FILE_PATTERN.test(avatarUrl)) {
        return null;
    }

    const sanitizedAvatar = sanitize(avatarUrl);
    if (!sanitizedAvatar || sanitizedAvatar !== avatarUrl || path.basename(avatarUrl) !== avatarUrl) {
        return null;
    }

    const filePath = path.resolve(directories.characterDesigner, `${path.parse(avatarUrl).name}.json`);
    const directoryPath = path.resolve(directories.characterDesigner);
    if (!filePath.startsWith(`${directoryPath}${path.sep}`)) {
        return null;
    }

    return filePath;
}

function requireWorkspaceFilePath(directories, avatarUrl) {
    const filePath = getWorkspaceFilePath(directories, avatarUrl);
    if (!filePath) {
        const error = new Error('Invalid avatar filename');
        error.statusCode = 400;
        throw error;
    }
    return filePath;
}

export async function renameCharacterDesignerWorkspace(directories, oldAvatarUrl, newAvatarUrl) {
    const oldFilePath = requireWorkspaceFilePath(directories, oldAvatarUrl);
    const newFilePath = requireWorkspaceFilePath(directories, newAvatarUrl);
    assertWorkspaceRenameAvailable(oldFilePath, newFilePath);
    if (oldFilePath === newFilePath || !fs.existsSync(oldFilePath)) return;
    await fsPromises.mkdir(path.dirname(newFilePath), { recursive: true });
    await fsPromises.rename(oldFilePath, newFilePath);
}

function assertWorkspaceRenameAvailable(oldFilePath, newFilePath) {
    if (oldFilePath === newFilePath || !fs.existsSync(newFilePath)) return;
    const error = new Error('Character Designer workspace already exists for the new avatar');
    error.code = 'EEXIST';
    throw error;
}

export function assertCharacterDesignerWorkspaceRenameAvailable(directories, oldAvatarUrl, newAvatarUrl) {
    const oldFilePath = requireWorkspaceFilePath(directories, oldAvatarUrl);
    const newFilePath = requireWorkspaceFilePath(directories, newAvatarUrl);
    assertWorkspaceRenameAvailable(oldFilePath, newFilePath);
}

export async function deleteCharacterDesignerWorkspace(directories, avatarUrl) {
    const filePath = requireWorkspaceFilePath(directories, avatarUrl);
    await fsPromises.rm(filePath, { force: true });
}

export const router = express.Router();

router.post('/random-keywords', async (request, response) => {
    const count = Number(request.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
        return response.status(400).send({ error: 'count must be an integer from 1 to 100.' });
    }

    try {
        const entries = (await fsPromises.readFile(KEYWORDS_PATH, 'utf8'))
            .split(/\r?\n/)
            .map(entry => entry.trim())
            .filter(Boolean);
        // Partial Fisher-Yates selects without replacement; randomInt avoids modulo bias.
        for (let index = 0; index < Math.min(count, entries.length); index++) {
            const selected = index + randomInt(entries.length - index);
            [entries[index], entries[selected]] = [entries[selected], entries[index]];
        }
        return response.send({ keywords: entries.slice(0, count).join(' ') });
    } catch (error) {
        console.error('Character Designer keyword resource could not be read.', error);
        return response.status(500).send({ error: 'Character Designer keywords are unavailable.' });
    }
});

router.post('/load', async (request, response) => {
    try {
        const filePath = requireWorkspaceFilePath(request.user.directories, request.body?.avatar_url);
        if (!fs.existsSync(filePath)) {
            return response.send({ workspace: null });
        }

        const workspace = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        return response.send({ workspace });
    } catch (error) {
        console.error('Failed to load Character Designer workspace:', error);
        return response.status(error.statusCode || 500).send({ error: 'character designer workspace load failed' });
    }
});

router.post('/save', async (request, response) => {
    try {
        const filePath = requireWorkspaceFilePath(request.user.directories, request.body?.avatar_url);
        if (!request.body?.workspace || typeof request.body.workspace !== 'object' || Array.isArray(request.body.workspace)) {
            return response.status(400).send({ error: 'workspace must be an object' });
        }

        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        writeFileAtomicSyncWithRetry(filePath, JSON.stringify(request.body.workspace, null, 4), 'utf8');
        return response.send({ result: 'ok' });
    } catch (error) {
        console.error('Failed to save Character Designer workspace:', error);
        return response.status(error.statusCode || 500).send({ error: 'character designer workspace save failed' });
    }
});
