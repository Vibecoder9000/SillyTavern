import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { normalizeWorkspaceName } from './sandbox.js';

export const DEFAULT_MAX_CHARS = 8000;
export const LAST_CHAT_SNAPSHOT_MARKER = '[earlier content omitted]\n';

const writeQueues = new Map();

// Keep this deliberately conservative. Negations are intentionally absent.
const LOW_INFORMATION_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
    'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
    'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
    'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'of', 'on', 'once', 'only', 'or', 'other',
    'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
    'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
    'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
    'whom', 'why', 'will', 'with', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

function getWorkspacePath(directories, workspace) {
    const normalized = normalizeWorkspaceName(workspace);
    const filename = sanitize(normalized) || '__root__';
    return {
        workspace: normalized,
        filePath: path.resolve(directories.workspaceContext, `${filename}.md`),
    };
}

function protectText(value) {
    const protectedValues = [];
    const protectedPattern = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s]+|\b[^\s@]+@[^\s@]+\.[^\s@]+|\b(?=[A-Za-z0-9_-]*[_\d-])[A-Za-z_][A-Za-z0-9_-]*\b/g;
    const protectedText = String(value ?? '').replace(protectedPattern, match => {
        const token = `\u0000PROTECTED_${protectedValues.length}\u0000`;
        protectedValues.push(match);
        return token;
    });
    return { protectedText, protectedValues };
}

function removeLowInformationWords(value) {
    const { protectedText, protectedValues } = protectText(value);
    const filtered = protectedText.replace(/\b[A-Za-z]+\b/g, word => LOW_INFORMATION_WORDS.has(word.toLowerCase()) ? '' : word);
    const normalized = filtered.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\s+([,.;:!?])/g, '$1').trim();
    return normalized.replace(/\u0000PROTECTED_(\d+)\u0000/g, (_, index) => protectedValues[Number(index)] ?? '');
}

export function serializeWorkspaceMirror(chatData) {
    const messages = Array.isArray(chatData) && chatData[0]?.chat_metadata
        ? chatData.slice(1)
        : (Array.isArray(chatData) ? chatData : []);
    const blocks = [];

    for (const message of messages) {
        if (!message || message.is_system || message.extra?.is_tool_call || message.extra?.is_tool_result) {
            continue;
        }

        const name = String(message.name ?? (message.is_user ? 'User' : 'Assistant')).trim() || (message.is_user ? 'User' : 'Assistant');
        const text = String(message.mes ?? '').trim();
        if (message.is_user) {
            if (!text) {
                continue;
            }
            blocks.push(`User (${name}):\n${text}`);
            continue;
        }

        const reasoning = String(message.extra?.reasoning ?? '').trim();
        if (reasoning) {
            blocks.push(`Reasoning (${name}):\n${reasoning}`);
        }
        if (text) {
            blocks.push(`Response (${name}):\n${text}`);
        }
    }

    return blocks.join('\n\n');
}

function compactBlock(block) {
    const lines = block.split('\n');
    const label = lines.shift()?.trim() ?? '';
    const content = removeLowInformationWords(lines.join('\n'));
    return content ? `${label}\n${content}` : label;
}

export function compactWorkspaceSnapshot(value, maxChars = DEFAULT_MAX_CHARS) {
    const numericLimit = Number(maxChars);
    const limit = Number.isFinite(numericLimit) && numericLimit >= 0
        ? Math.trunc(numericLimit)
        : DEFAULT_MAX_CHARS;
    if (limit === 0) {
        return '';
    }

    const normalizedSource = String(value ?? '').replace(/\r\n?/g, '\n');
    const blocks = normalizedSource.split(/\n\s*(?=(?:User|Reasoning|Response) \([^\n]*\):\n)/);
    const normalized = blocks.map(compactBlock).filter(Boolean).join('\n\n');
    const codePoints = Array.from(normalized);
    if (codePoints.length <= limit) {
        return normalized;
    }

    const marker = LAST_CHAT_SNAPSHOT_MARKER;
    const markerPoints = Array.from(marker);
    if (markerPoints.length >= limit) {
        return markerPoints.slice(0, limit).join('');
    }
    return marker + codePoints.slice(-(limit - markerPoints.length)).join('');
}

function enqueueWrite(key, operation) {
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const queued = current.finally(() => {
        if (writeQueues.get(key) === queued) {
            writeQueues.delete(key);
        }
    });
    writeQueues.set(key, queued);
    return queued;
}

export async function syncWorkspaceMirror({ directories, workspace, chat }) {
    const { workspace: normalized, filePath } = getWorkspacePath(directories, workspace);
    const key = `${directories.root}\u0000${normalized}`;
    const mirror = serializeWorkspaceMirror(chat);
    await enqueueWrite(key, async () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileAtomicSync(filePath, mirror, { encoding: 'utf8' });
    });
    return { workspace: normalized, path: filePath };
}

export function readWorkspaceSnapshot({ directories, workspace, maxChars }) {
    const { workspace: normalized, filePath } = getWorkspacePath(directories, workspace);
    let mirror = '';
    try {
        mirror = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    } catch (error) {
        console.warn(`Failed to read workspace last-chat mirror at ${filePath}:`, error);
        throw error;
    }
    return {
        workspace: normalized,
        path: filePath,
        snapshot: compactWorkspaceSnapshot(mirror, maxChars),
    };
}

export const router = express.Router();

router.post('/sync', async (request, response) => {
    try {
        if (!Array.isArray(request.body?.chat)) {
            return response.status(400).send({ error: 'chat must be an array' });
        }
        const result = await syncWorkspaceMirror({
            directories: request.user.directories,
            workspace: request.body.workspace,
            chat: request.body.chat,
        });
        return response.send({ ok: true, ...result });
    } catch (error) {
        console.error('Failed to sync workspace last-chat mirror:', error);
        return response.status(500).send({ error: 'workspace mirror sync failed' });
    }
});

router.post('/snapshot', (request, response) => {
    try {
        return response.send(readWorkspaceSnapshot({
            directories: request.user.directories,
            workspace: request.body?.workspace,
            maxChars: request.body?.max_chars,
        }));
    } catch (error) {
        console.error('Failed to capture workspace last-chat snapshot:', error);
        return response.status(500).send({ error: 'workspace snapshot failed' });
    }
});
