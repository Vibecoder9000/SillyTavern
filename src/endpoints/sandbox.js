import path from 'node:path';
import sanitize from 'sanitize-filename';

export const ROOT_WORKSPACE_SENTINEL = '__root__';
export const ASSISTANT_CHARACTER_NAME = 'Assistant';

/**
 * Returns the sandbox root directory for a given user handle.
 * Each user gets their own sandbox under their data directory.
 * @param {string} userHandle The user's directory handle.
 * @returns {string} Absolute path to the user's sandbox root.
 */
export function getUserSandboxRootDir(userHandle) {
    return path.resolve(path.join(globalThis.DATA_ROOT, userHandle, 'uploads'));
}

/**
 * Checks whether the given character should be treated as the global Assistant.
 * @param {unknown} character Character name sent by the client.
 * @returns {boolean}
 */
export function isAssistantCharacter(character) {
    return typeof character === 'string'
        && character.trim().toLowerCase() === ASSISTANT_CHARACTER_NAME.toLowerCase();
}

/**
 * Normalizes workspace name, preserving the root sentinel and sanitizing folder names.
 * @param {unknown} workspace Workspace value from request.
 * @returns {string}
 */
export function normalizeWorkspaceName(workspace) {
    if (typeof workspace !== 'string') {
        return ROOT_WORKSPACE_SENTINEL;
    }

    const trimmed = workspace.trim();
    if (!trimmed || trimmed === ROOT_WORKSPACE_SENTINEL) {
        return ROOT_WORKSPACE_SENTINEL;
    }

    const sanitized = sanitize(trimmed);
    return sanitized || ROOT_WORKSPACE_SENTINEL;
}

/**
 * Resolves final workspace name, applying assistant root override.
 * @param {unknown} workspace Workspace value from request.
 * @param {unknown} character Active character name from request.
 * @returns {string}
 */
export function resolveWorkspaceName(workspace, character) {
    if (isAssistantCharacter(character)) {
        return ROOT_WORKSPACE_SENTINEL;
    }

    return normalizeWorkspaceName(workspace);
}

/**
 * Resolves absolute sandbox directory from user handle, workspace and character context.
 * @param {string} userHandle The user's directory handle.
 * @param {unknown} workspace Workspace value from request.
 * @param {unknown} character Active character name from request.
 * @returns {string}
 */
export function getSandboxDir(userHandle, workspace, character) {
    const sandboxRoot = getUserSandboxRootDir(userHandle);
    const resolvedWorkspace = resolveWorkspaceName(workspace, character);

    if (resolvedWorkspace === ROOT_WORKSPACE_SENTINEL) {
        return sandboxRoot;
    }

    return path.resolve(path.join(sandboxRoot, resolvedWorkspace));
}

/**
 * True when candidatePath is inside basePath or equal to it.
 * @param {string} basePath
 * @param {string} candidatePath
 * @returns {boolean}
 */
export function isPathInside(basePath, candidatePath) {
    const relativePath = path.relative(basePath, candidatePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
