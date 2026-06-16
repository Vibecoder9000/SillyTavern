import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import { getSandboxDir, getUserSandboxRootDir } from './sandbox.js';
import { addMcpToolRoutes } from './tools-mcp.js';

export const router = express.Router();

const SD_WEBUI_URL = 'http://localhost:7860';
const BROWSER_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BROWSER_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const BROWSER_MAX_SESSIONS_PER_USER = 32;
const BROWSER_DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const BROWSER_MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_PYTHON_TIMEOUT_MS = 120_000;
const MAX_PYTHON_TIMEOUT_MS = 900_000;
const DOM_FETCH_DEFAULT_MAX_CHARS = 12_000;
const DOM_FETCH_MAX_CHARS = 30_000;
const EXECUTE_JS_TIMEOUT_MS = 5_000;
const EXECUTE_JS_RESULT_MAX_CHARS = 20_000;
const DEFAULT_BROWSER_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0';
const BROWSER_HEADLESS = String(process.env.ST_BROWSER_HEADLESS ?? '').trim() === '1';
const BROWSER_DOWNLOAD_TIMEOUT_MS = 30_000;
const BROWSER_LIST_DEFAULT_LIMIT = 20;
const BROWSER_LIST_MAX_LIMIT = 50;
const BROWSER_CLICKABLE_ELEMENTS_LIMIT = 10;
const BROWSER_ACTION_HISTORY_LIMIT = 12;
const BROWSER_LOOP_DETECTION_WINDOW_MS = 30_000;
const BROWSER_LOOP_DETECTION_THRESHOLD = 3;
const BROWSER_SCREENSHOT_GRID_STEP_PX = 200;
const BROWSER_SCREENSHOT_GRID_MAJOR_STEP_PX = 600;
const BROWSER_SCREENSHOT_GRID_PERSIST_MS = 3_000;
const BROWSER_SCREENSHOT_CLICK_PERSIST_MS = 5_000;
const browserStates = new Map();
const SANDBOX_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const SANDBOX_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov']);

// Track active processes to kill previous ones when new ones start
const activeProcesses = {
    python: null,
    shell: null,
};

const COMMAND_DENYLIST = new Set([
    'mv',
    'shred',
    'dd',
    'truncate',
    'chmod',
    'chown',
    'move',
    'rename',
    'ren',
    'icacls',
]);
const DESTRUCTIVE_DELETE_COMMANDS = new Set([
    'rm',
    'del',
    'erase',
    'remove-item',
    'rmdir',
    'rd',
]);
const POWERSHELL_COMMAND = process.platform === 'win32' ? 'powershell.exe' : 'powershell';
const POWERSHELL_UTF8_PREAMBLE = [
    '$utf8NoBom = New-Object System.Text.UTF8Encoding $false',
    '[Console]::InputEncoding = $utf8NoBom',
    '[Console]::OutputEncoding = $utf8NoBom',
    '$OutputEncoding = $utf8NoBom',
    "$ProgressPreference = 'SilentlyContinue'",
].join('; ');

let cachedPythonLauncher = null;
let playwrightModulePromise = null;

const browserCleanupInterval = setInterval(() => {
    cleanupIdleBrowserSessions().catch(error => {
        console.error('Failed to clean up idle browser sessions:', error);
    });
}, BROWSER_SESSION_SWEEP_INTERVAL_MS);

if (typeof browserCleanupInterval.unref === 'function') {
    browserCleanupInterval.unref();
}

/**
 * @typedef {object} BrowserSession
 * @property {string} id
 * @property {import('playwright').Page} page
 * @property {Set<import('playwright').Page>} pages
 * @property {Map<import('playwright').Page, Array<{index:number,selector:string,frameIndex:number,kind:string,text:string,href?:string}>>} elementCache
 * @property {Map<import('playwright').Page, {url:string,collectedAt:number}>} elementCacheMeta
 * @property {Map<import('playwright').Page, {descriptors:Array<{index:number,selector:string,frameIndex:number,kind:string,text:string,href?:string}>,url:string,staleAt:number}>} staleElementCache
 * @property {Array<{fingerprint:string,at:number}>} recentActions
 * @property {Promise<unknown>} queue
 * @property {number} lastUsedAt
 * @property {unknown} workspace
 * @property {unknown} character
 */

/**
 * @typedef {object} BrowserState
 * @property {Promise<import('playwright').BrowserContext>|null} contextPromise
 * @property {import('playwright').BrowserContext|null} context
 * @property {Map<string, BrowserSession>} sessions
 */

/**
 * Resolves an available Python launcher command for the current platform.
 * @returns {{command: string, args: string[]}|null}
 */
function resolvePythonLauncher() {
    if (cachedPythonLauncher) {
        return cachedPythonLauncher;
    }

    const candidates = process.platform === 'win32'
        ? [
            { command: 'python', args: [] },
            { command: 'py', args: ['-3'] },
            { command: 'python3', args: [] },
        ]
        : [
            { command: 'python3', args: [] },
            { command: 'python', args: [] },
        ];

    for (const candidate of candidates) {
        try {
            const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
                shell: false,
                stdio: 'ignore',
            });

            if (!probe.error && probe.status === 0) {
                cachedPythonLauncher = candidate;
                return candidate;
            }
        } catch {
            // Try the next launcher candidate.
        }
    }

    return null;
}

/**
 * Gets the Playwright Firefox browser type via a lazy import so the server still starts when the package
 * is not installed yet.
 * @returns {Promise<import('playwright').BrowserType>}
 */
async function getPlaywrightFirefox() {
    playwrightModulePromise ??= import('playwright');
    const module = await playwrightModulePromise;
    return module.firefox;
}

/**
 * Returns the per-user browser runtime directory.
 * @param {string} userHandle
 * @returns {string}
 */
function getBrowserRuntimeDir(userHandle) {
    return path.join(getUserSandboxRootDir(userHandle), '.browser-runtime');
}

/**
 * Returns the profile directory used by Playwright persistent Firefox.
 * @param {string} userHandle
 * @returns {string}
 */
function getBrowserProfileDir(userHandle) {
    return path.join(getBrowserRuntimeDir(userHandle), 'profile');
}

/**
 * Gets or creates the browser state holder for a user.
 * @param {string} userHandle
 * @returns {BrowserState}
 */
function getBrowserState(userHandle) {
    if (!browserStates.has(userHandle)) {
        browserStates.set(userHandle, {
            contextPromise: null,
            context: null,
            sessions: new Map(),
        });
    }

    return browserStates.get(userHandle);
}

/**
 * Returns the most recently used live browser session for a user, if any.
 * @param {string} userHandle
 * @returns {BrowserSession|null}
 */
function getMostRecentBrowserSession(userHandle) {
    const state = getBrowserState(userHandle);
    const sessions = Array.from(state.sessions.values())
        .filter(session => session.page && !session.page.isClosed())
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return sessions[0] ?? null;
}

/**
 * Closes a session page and removes it from the registry.
 * @param {string} userHandle
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function destroyBrowserSession(userHandle, sessionId) {
    const state = getBrowserState(userHandle);
    const session = state.sessions.get(sessionId);

    if (!session) {
        return;
    }

    state.sessions.delete(sessionId);

    try {
        for (const page of session.pages) {
            if (!page.isClosed()) {
                await page.close({ runBeforeUnload: false });
            }
        }
    } catch (error) {
        console.warn(`Failed to close browser session "${sessionId}":`, error);
    }

    if (state.sessions.size === 0 && state.context) {
        try {
            await state.context.close();
        } catch (error) {
            console.warn(`Failed to close browser context for "${userHandle}":`, error);
        } finally {
            state.context = null;
            state.contextPromise = null;
        }
    }
}

/**
 * Cleans up sessions that have been idle for too long.
 * @returns {Promise<void>}
 */
async function cleanupIdleBrowserSessions() {
    const now = Date.now();

    for (const [userHandle, state] of browserStates.entries()) {
        for (const [sessionId, session] of state.sessions.entries()) {
            if (now - session.lastUsedAt > BROWSER_SESSION_IDLE_TIMEOUT_MS) {
                await destroyBrowserSession(userHandle, sessionId);
            }
        }
    }
}

/**
 * Launches or reuses the per-user Firefox persistent context.
 * @param {string} userHandle
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function getBrowserContext(userHandle) {
    const state = getBrowserState(userHandle);

    if (state.context && state.context.browser()?.isConnected() !== false) {
        return state.context;
    }

    if (!state.contextPromise) {
        state.contextPromise = (async () => {
            const firefox = await getPlaywrightFirefox();
            const profileDir = getBrowserProfileDir(userHandle);
            const runtimeDir = getBrowserRuntimeDir(userHandle);
            await fs.mkdir(profileDir, { recursive: true });
            await fs.mkdir(runtimeDir, { recursive: true });

            try {
                const context = await firefox.launchPersistentContext(profileDir, {
                    headless: BROWSER_HEADLESS,
                    viewport: DEFAULT_BROWSER_VIEWPORT,
                    locale: 'en-US',
                    timezoneId: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                    userAgent: DEFAULT_BROWSER_USER_AGENT,
                    ignoreHTTPSErrors: true,
                    acceptDownloads: true,
                    colorScheme: 'light',
                    javaScriptEnabled: true,
                    bypassCSP: false,
                    extraHTTPHeaders: {
                        'Accept-Language': 'en-US,en;q=0.9',
                        'DNT': '1',
                    },
                    firefoxUserPrefs: {
                        'intl.accept_languages': 'en-US, en',
                    },
                    slowMo: BROWSER_HEADLESS ? 0 : 45,
                });

                context.setDefaultNavigationTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);
                context.setDefaultTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);
                context.on('close', () => {
                    state.context = null;
                    state.contextPromise = null;
                });

                state.context = context;
                return context;
            } catch (error) {
                state.context = null;
                if (String(error?.message ?? '').includes('Executable doesn\'t exist')) {
                    throw new Error('Firefox for Playwright is not installed. Run `npx playwright install firefox` and restart the server.');
                }
                throw error;
            } finally {
                state.contextPromise = null;
            }
        })();
    }

    return await state.contextPromise;
}

/**
 * Resolves and validates an HTTP/HTTPS URL.
 * @param {string} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeHttpUrl(value, fieldName = 'url') {
    try {
        const normalized = new URL(String(value ?? '').trim());
        if (!['http:', 'https:'].includes(normalized.protocol)) {
            throw new Error('Invalid protocol');
        }
        return normalized.toString();
    } catch {
        throw new Error(`${fieldName} must be a valid HTTP or HTTPS URL.`);
    }
}

/**
 * Returns true when the selector string is usable.
 * @param {unknown} selector
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeSelector(selector, fieldName = 'selector') {
    const value = String(selector ?? '').trim();
    if (!value) {
        throw new Error(`${fieldName} is required.`);
    }
    return value;
}

/**
 * Returns true when the visible text query string is usable.
 * @param {unknown} text
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeVisibleText(text, fieldName = 'text') {
    const value = String(text ?? '').trim();
    if (!value) {
        throw new Error(`${fieldName} is required.`);
    }
    return value;
}

/**
 * Sleeps for a short random delay so actions feel less bursty.
 * @returns {Promise<void>}
 */
async function randomHumanDelay() {
    const delayMs = 120 + Math.floor(Math.random() * 280);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Sanitizes a filename for filesystem use.
 * @param {string} filename
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeFilename(filename, fallback) {
    const sanitized = path.basename(String(filename ?? '').trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    return sanitized || fallback;
}

/**
 * Returns true when a URL appears to point to a direct asset instead of an HTML page.
 * @param {string} url
 * @returns {boolean}
 */
function isDirectAssetUrl(url) {
    return /\.(?:png|jpe?g|webp|gif|bmp|svg|pdf|txt|json|webm|mp4|mp3|wav|ogg)(?:[?#].*)?$/i.test(url);
}

/**
 * Resolves a writable sandbox path.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @param {string|null|undefined} filepath
 * @param {string} fallbackPath
 * @returns {Promise<{ filepath: string, fullPath: string }>}
 */
async function resolveSandboxWritePath(userHandle, workspace, character, filepath, fallbackPath) {
    let relativePath = String(filepath ?? fallbackPath).trim().replaceAll('\\', '/');

    if (!relativePath) {
        relativePath = fallbackPath;
    }

    const sandboxDir = getSandboxDir(userHandle, workspace, character);
    const fullPath = path.resolve(sandboxDir, relativePath);
    const directory = path.dirname(fullPath);
    await fs.mkdir(directory, { recursive: true });

    return { filepath: relativePath, fullPath };
}

/**
 * Downloads an HTTP(S) URL directly into the sandbox.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @param {string} url
 * @param {string|null|undefined} filepath
 * @param {string} referer
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<{ filepath: string, filename: string, size: number, source_url: string, mime_type: string|null }>}
 */
async function downloadHttpUrlToSandbox(userHandle, workspace, character, url, filepath, referer = '', extraHeaders = {}) {
    const downloadUrl = normalizeHttpUrl(url, 'url');
    const response = await fetch(downloadUrl, {
        redirect: 'follow',
        headers: {
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': DEFAULT_BROWSER_USER_AGENT,
            ...(referer ? { Referer: referer } : {}),
            ...extraHeaders,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to download URL. HTTP ${response.status} ${response.statusText}.`);
    }

    const resolvedUrl = response.url || downloadUrl;
    const filename = sanitizeFilename(path.posix.basename(new URL(resolvedUrl).pathname), `download_${Date.now()}`);
    const output = await resolveSandboxWritePath(
        userHandle,
        workspace,
        character,
        filepath,
        `downloads/${filename}`,
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(output.fullPath, buffer);

    return {
        filepath: output.filepath,
        filename: path.basename(output.filepath),
        size: buffer.length,
        source_url: resolvedUrl,
        mime_type: response.headers.get('content-type'),
    };
}

/**
 * Returns true when a downloaded file appears to be an image.
 * @param {string|null|undefined} filepath
 * @param {string|null|undefined} mimeType
 * @returns {boolean}
 */
function isImageDownload(filepath, mimeType = '') {
    if (String(mimeType ?? '').toLowerCase().startsWith('image/')) {
        return true;
    }

    return /\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(String(filepath ?? '').trim());
}

/**
 * Guesses the mime type from a filepath extension.
 * @param {string|null|undefined} filepath
 * @returns {string|null}
 */
function guessMimeTypeFromFilepath(filepath) {
    const value = String(filepath ?? '').trim().toLowerCase();
    if (value.endsWith('.png')) return 'image/png';
    if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg';
    if (value.endsWith('.webp')) return 'image/webp';
    if (value.endsWith('.gif')) return 'image/gif';
    if (value.endsWith('.bmp')) return 'image/bmp';
    if (value.endsWith('.svg')) return 'image/svg+xml';
    if (value.endsWith('.pdf')) return 'application/pdf';
    if (value.endsWith('.txt')) return 'text/plain';
    if (value.endsWith('.json')) return 'application/json';
    if (value.endsWith('.webm')) return 'video/webm';
    if (value.endsWith('.mp4')) return 'video/mp4';
    return null;
}

/**
 * Returns the supported sandbox media kind for a filepath extension.
 * @param {string} filepath
 * @returns {'image'|'video'|null}
 */
function getSandboxMediaKind(filepath) {
    const extension = path.extname(String(filepath ?? '').trim()).toLowerCase();
    if (SANDBOX_IMAGE_EXTENSIONS.has(extension)) {
        return 'image';
    }

    if (SANDBOX_VIDEO_EXTENSIONS.has(extension)) {
        return 'video';
    }

    return null;
}

/**
 * Validates a media file and returns basic metadata.
 * This is intentionally permissive: it checks that raster images decode to non-zero dimensions,
 * while leaving model/API-specific acceptance rules to downstream consumers.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @param {unknown} filepath
 * @param {{ allowVideo?: boolean }} [options]
 * @returns {Promise<{ filepath: string, kind: 'image'|'video', size: number, width?: number, height?: number, mime_type?: string|null }>}
 */
async function inspectSandboxMediaFile(userHandle, workspace, character, filepath, { allowVideo = false } = {}) {
    const trimmedFilepath = String(filepath ?? '').trim();
    if (!trimmedFilepath) {
        throw new Error('filepath is required.');
    }

    const sandboxDir = getSandboxDir(userHandle, workspace, character);
    const fullPath = path.isAbsolute(trimmedFilepath)
        ? trimmedFilepath
        : path.resolve(sandboxDir, trimmedFilepath);

    const mediaKind = getSandboxMediaKind(trimmedFilepath);
    if (mediaKind === 'image') {
        // Continue below.
    } else if (mediaKind === 'video' && allowVideo) {
        // Continue below.
    } else if (allowVideo) {
        throw new Error(`The file "${trimmedFilepath}" is not a supported image or video type.`);
    } else {
        throw new Error(`The file "${trimmedFilepath}" is not a supported image type.`);
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
        throw new Error(`The file "${trimmedFilepath}" is not a file.`);
    }

    const info = {
        filepath: trimmedFilepath,
        kind: mediaKind,
        size: stats.size,
        mime_type: guessMimeTypeFromFilepath(trimmedFilepath),
    };

    if (mediaKind !== 'image') {
        return info;
    }

    const buffer = await fs.readFile(fullPath);
    if (buffer.length === 0) {
        throw new Error(`The file "${trimmedFilepath}" is empty.`);
    }

    const extension = path.extname(trimmedFilepath).toLowerCase();
    if (extension === '.svg') {
        const svgText = buffer.toString('utf8').trim();
        if (!svgText || !/<svg\b/i.test(svgText)) {
            throw new Error(`The file "${trimmedFilepath}" is not a valid SVG image.`);
        }
        return info;
    }

    let dimensions;
    try {
        dimensions = imageSize(buffer);
    } catch {
        throw new Error(`The file "${trimmedFilepath}" is not a valid image.`);
    }

    if (!dimensions?.width || !dimensions?.height) {
        throw new Error(`The file "${trimmedFilepath}" is not a valid image.`);
    }

    return {
        ...info,
        width: dimensions.width,
        height: dimensions.height,
    };
}

/**
 * Updates session access time and active sandbox context.
 * @param {BrowserSession} session
 * @param {unknown} workspace
 * @param {unknown} character
 */
function touchBrowserSession(session, workspace, character) {
    session.lastUsedAt = Date.now();
    if (typeof workspace !== 'undefined') {
        session.workspace = workspace;
    }
    if (typeof character !== 'undefined') {
        session.character = character;
    }
}

/**
 * Enqueues an action for a browser session so actions do not race each other.
 * @template T
 * @param {BrowserSession} session
 * @param {(session: BrowserSession) => Promise<T>} action
 * @returns {Promise<T>}
 */
async function runBrowserSessionAction(session, action) {
    const run = async () => {
        touchBrowserSession(session, session.workspace, session.character);
        return await action(session);
    };
    const next = session.queue.then(run, run);
    session.queue = next.catch(() => undefined);
    return await next;
}

/**
 * Gets an existing browser session for a user.
 * @param {string} userHandle
 * @param {string} sessionId
 * @returns {BrowserSession}
 */
function getExistingBrowserSession(userHandle, sessionId) {
    const state = getBrowserState(userHandle);
    const session = state.sessions.get(String(sessionId ?? '').trim());

    if (!session) {
        throw new Error(`No browser session found for session_id "${sessionId}". Open a page first with browser_open.`);
    }

    if (session.page.isClosed()) {
        state.sessions.delete(session.id);
        throw new Error(`Browser session "${sessionId}" has already been closed.`);
    }

    return session;
}

/**
 * Returns the currently tracked open tabs for a session in stable order.
 * @param {BrowserSession} session
 * @returns {import('playwright').Page[]}
 */
function getSessionPages(session) {
    const pages = Array.from(session.pages).filter(page => !page.isClosed());
    session.pages = new Set(pages);

    if ((!session.page || session.page.isClosed()) && pages.length > 0) {
        session.page = pages[0];
    }

    return pages;
}

/**
 * Gets a session page by explicit tab index or falls back to the active tab.
 * @param {BrowserSession} session
 * @param {unknown} tabIndex
 * @returns {import('playwright').Page}
 */
function getSessionPage(session, tabIndex) {
    const pages = getSessionPages(session);
    if (pages.length === 0) {
        throw new Error(`Browser session "${session.id}" has no open tabs.`);
    }

    if (tabIndex === null || typeof tabIndex === 'undefined' || String(tabIndex).trim() === '') {
        return session.page ?? pages[0];
    }

    const index = Number(tabIndex);
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
        throw new Error(`tab_index must be an integer between 0 and ${Math.max(0, pages.length - 1)}.`);
    }

    return pages[index];
}

/**
 * Gets the stable tab index for a page within a session.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @returns {number}
 */
function getSessionTabIndex(session, page) {
    return getSessionPages(session).indexOf(page);
}

/**
 * Stores the current descriptor cache snapshot for a page.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @param {Array<{index:number,selector:string,frameIndex:number,kind:string,text:string,href?:string}>} descriptors
 * @param {string} [url]
 * @returns {void}
 */
function setSessionElementDescriptors(session, page, descriptors, url = '') {
    session.elementCache.set(page, Array.isArray(descriptors) ? descriptors : []);
    session.elementCacheMeta.set(page, {
        url: String(url || page.url() || ''),
        collectedAt: Date.now(),
    });
}

/**
 * Builds a stable fingerprint for recent browser actions.
 * @param {string} action
 * @param {string} pageUrl
 * @param {object} details
 * @returns {string}
 */
function getBrowserActionFingerprint(action, pageUrl, details = {}) {
    const normalizedUrl = (() => {
        try {
            const url = new URL(pageUrl);
            url.hash = '';
            return url.toString();
        } catch {
            return String(pageUrl ?? '').trim();
        }
    })();

    return JSON.stringify({
        action,
        pageUrl: normalizedUrl,
        selector: String(details.selector ?? '').trim(),
        text: String(details.text ?? '').trim(),
        elementIndex: Number.isInteger(details.elementIndex) ? details.elementIndex : null,
        x: Number.isFinite(details.x) ? Math.round(details.x) : null,
        y: Number.isFinite(details.y) ? Math.round(details.y) : null,
    });
}

/**
 * Detects repeated identical browser actions in a short window.
 * @param {BrowserSession} session
 * @param {string} fingerprint
 * @returns {{detected:boolean,count:number}}
 */
function detectBrowserActionLoop(session, fingerprint) {
    const now = Date.now();
    session.recentActions = (session.recentActions ?? [])
        .filter(action => now - action.at <= BROWSER_LOOP_DETECTION_WINDOW_MS)
        .slice(-BROWSER_ACTION_HISTORY_LIMIT);

    const count = session.recentActions.filter(action => action.fingerprint === fingerprint).length + 1;
    return {
        detected: count >= BROWSER_LOOP_DETECTION_THRESHOLD,
        count,
    };
}

/**
 * Records a browser action in the session history.
 * @param {BrowserSession} session
 * @param {string} fingerprint
 * @returns {void}
 */
function recordBrowserAction(session, fingerprint) {
    const now = Date.now();
    session.recentActions = (session.recentActions ?? [])
        .filter(action => now - action.at <= BROWSER_LOOP_DETECTION_WINDOW_MS)
        .slice(-(BROWSER_ACTION_HISTORY_LIMIT - 1));
    session.recentActions.push({ fingerprint, at: now });
}

/**
 * Returns a serializable tab list for a session.
 * @param {BrowserSession} session
 * @returns {Promise<Array<{index:number,title:string,url:string,active:boolean}>>}
 */
async function getSessionTabsSnapshot(session) {
    const pages = getSessionPages(session);
    return await Promise.all(pages.map(async (page, index) => ({
        index,
        title: await page.title().catch(() => ''),
        url: page.url(),
        active: page === session.page,
    })));
}

/**
 * Creates a new browser session for the user.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @returns {Promise<BrowserSession>}
 */
async function createBrowserSession(userHandle, workspace, character) {
    const state = getBrowserState(userHandle);

    if (state.sessions.size >= BROWSER_MAX_SESSIONS_PER_USER) {
        throw new Error(`Too many active browser sessions. Close an existing session before opening a new one. Max active sessions: ${BROWSER_MAX_SESSIONS_PER_USER}.`);
    }

    const context = await getBrowserContext(userHandle);
    const existingContextPages = context.pages().filter(page => !page.isClosed());
    const page = state.sessions.size === 0 && existingContextPages.length > 0
        ? existingContextPages[0]
        : await context.newPage();
    page.setDefaultNavigationTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);
    page.setDefaultTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);

    let sessionId = '';
    do {
        sessionId = crypto.randomBytes(6).toString('hex');
    } while (state.sessions.has(sessionId));

    const session = {
        id: sessionId,
        page,
        pages: new Set([page]),
        elementCache: new Map(),
        elementCacheMeta: new Map(),
        staleElementCache: new Map(),
        recentActions: [],
        queue: Promise.resolve(),
        lastUsedAt: Date.now(),
        workspace,
        character,
    };

    state.sessions.set(session.id, session);
    trackSessionPage(session, page);

    return session;
}

/**
 * Tracks a page under a session for later cleanup.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @returns {void}
 */
function trackSessionPage(session, page) {
    session.pages.add(page);
    page.setDefaultNavigationTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);
    page.setDefaultTimeout(BROWSER_MAX_WAIT_TIMEOUT_MS);
    page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) {
            const descriptors = session.elementCache.get(page) ?? [];
            const meta = session.elementCacheMeta.get(page);
            if (descriptors.length > 0) {
                session.staleElementCache.set(page, {
                    descriptors,
                    url: meta?.url || page.url(),
                    staleAt: Date.now(),
                });
            }
            session.elementCache.delete(page);
            session.elementCacheMeta.delete(page);
        }
    });
    page.on('close', () => {
        session.pages.delete(page);
        session.elementCache.delete(page);
        session.elementCacheMeta.delete(page);
        session.staleElementCache.delete(page);
        if (session.page === page) {
            const replacement = Array.from(session.pages).find(candidate => !candidate.isClosed()) ?? null;
            if (replacement) {
                session.page = replacement;
            }
        }
    });
}

/**
 * Finds the first frame containing a selector.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {number} timeoutMs
 * @returns {Promise<{ frame: import('playwright').Frame, locator: import('playwright').Locator }>}
 */
async function findFrameLocator(page, selector, timeoutMs = 0) {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        for (const frame of page.frames()) {
            try {
                const locator = frame.locator(selector).first();
                if (await locator.count() > 0) {
                    return { frame, locator };
                }
            } catch {
                // Ignore invalid frames/selectors until timeout.
            }
        }

        if (Date.now() >= deadline) {
            throw new Error(`No element matched selector "${selector}".`);
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

/**
 * Finds a clickable locator by visible text across frames.
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {number} timeoutMs
 * @returns {Promise<{ frame: import('playwright').Frame, locator: import('playwright').Locator }>}
 */
async function collectVisibleTextLocatorMatches(page, query, maxMatches = 12) {
    const matches = [];
    const seen = new Set();
    const strategies = [
        { kind: 'button', createLocator: frame => frame.getByRole('button', { name: query, exact: true }) },
        { kind: 'link', createLocator: frame => frame.getByRole('link', { name: query, exact: true }) },
        { kind: 'menuitem', createLocator: frame => frame.getByRole('menuitem', { name: query, exact: true }) },
        { kind: 'tab', createLocator: frame => frame.getByRole('tab', { name: query, exact: true }) },
        { kind: 'text', createLocator: frame => frame.getByText(query, { exact: true }) },
    ];

    for (const frame of page.frames()) {
        for (const strategy of strategies) {
            let count = 0;
            try {
                count = Math.min(await strategy.createLocator(frame).count(), 25);
            } catch {
                continue;
            }

            for (let index = 0; index < count; index++) {
                const locator = strategy.createLocator(frame).nth(index);
                try {
                    const descriptor = await locator.evaluate((element, kind) => {
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
                        const label = element.getAttribute('aria-label') || element.getAttribute('title') || text;
                        return {
                            kind,
                            tag: element.tagName.toLowerCase(),
                            role: element.getAttribute('role') || '',
                            text,
                            label,
                            href: element instanceof HTMLAnchorElement ? element.href : '',
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                        };
                    }, strategy.kind);

                    if (!descriptor?.visible) {
                        continue;
                    }

                    const dedupeKey = [
                        frame.url(),
                        descriptor.kind,
                        descriptor.tag,
                        descriptor.role,
                        descriptor.label,
                        Math.round(descriptor.x),
                        Math.round(descriptor.y),
                        Math.round(descriptor.width),
                        Math.round(descriptor.height),
                    ].join('|');
                    if (seen.has(dedupeKey)) {
                        continue;
                    }

                    seen.add(dedupeKey);
                    matches.push({ frame, locator, descriptor });
                    if (matches.length >= maxMatches) {
                        return matches;
                    }
                } catch {
                    // Ignore and keep scanning.
                }
            }
        }
    }

    return matches;
}

async function findFrameLocatorByText(page, text, timeoutMs = 0, textIndex = null) {
    const query = normalizeVisibleText(text, 'text');
    const deadline = Date.now() + timeoutMs;
    const requestedIndex = Number.isInteger(textIndex) && textIndex >= 0 ? textIndex : null;

    while (true) {
        const maxMatches = requestedIndex === null ? 8 : Math.max(8, requestedIndex + 1);
        const matches = await collectVisibleTextLocatorMatches(page, query, maxMatches);

        if (matches.length > 0) {
            if (requestedIndex !== null) {
                if (requestedIndex < matches.length) {
                    const match = matches[requestedIndex];
                    return { frame: match.frame, locator: match.locator, descriptor: match.descriptor };
                }
            } else {
                const match = matches[0];
                return { frame: match.frame, locator: match.locator, descriptor: match.descriptor };
            }
        }

        if (Date.now() >= deadline) {
            const suffix = requestedIndex !== null ? ` with text_index ${requestedIndex}` : '';
            throw new Error(`No clickable element matched text "${query}"${suffix}.`);
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

/**
 * Waits for text to appear in any frame.
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForTextAcrossFrames(page, text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            try {
                const locator = frame.getByText(text, { exact: false }).first();
                if (await locator.count() > 0) {
                    await locator.waitFor({ timeout: 1000 });
                    return;
                }
            } catch {
                // Ignore and keep polling.
            }
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    throw new Error(`Timed out waiting for text "${text}".`);
}

/**
 * Waits briefly for the page to settle after an interaction without blocking too long on noisy pages.
 * @param {import('playwright').Page} page
 * @param {number} [networkIdleTimeoutMs]
 * @returns {Promise<void>}
 */
async function waitForPageAfterInteraction(page, networkIdleTimeoutMs = 2_500) {
    await page.waitForLoadState('domcontentloaded', { timeout: BROWSER_DEFAULT_WAIT_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForLoadState('load', { timeout: Math.min(BROWSER_DEFAULT_WAIT_TIMEOUT_MS, 5_000) }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: networkIdleTimeoutMs }).catch(() => undefined);
    await waitForPageVisualReady(page, Math.min(BROWSER_DEFAULT_WAIT_TIMEOUT_MS, 5_000));
    await page.waitForTimeout(500).catch(() => undefined);
}

/**
 * Waits for a page to have meaningful visible DOM content instead of relying only on load events.
 * This helps avoid returning too early on sites that paint after the initial navigation signal.
 * @param {import('playwright').Page} page
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForPageVisualReady(page, timeoutMs = 5_000) {
    await page.waitForFunction(() => {
        const root = document.documentElement;
        const body = document.body;
        if (!root || !body) {
            return false;
        }

        const hasViewport = root.clientWidth > 0 && root.clientHeight > 0;
        if (!hasViewport) {
            return false;
        }

        const textLength = (body.innerText || '').replace(/\s+/g, '').length;
        const meaningfulNodeCount = body.querySelectorAll('img, svg, canvas, video, picture, main, article, section, [role="main"], [role="dialog"], input, button, a').length;
        const childCount = body.children.length;

        return textLength >= 20 || meaningfulNodeCount > 0 || childCount > 1;
    }, { timeout: timeoutMs }).catch(() => undefined);

    await page.waitForTimeout(250).catch(() => undefined);
}

/**
 * Waits briefly for a popup/new tab after an interaction and tracks it if present.
 * @param {BrowserSession} session
 * @param {Promise<import('playwright').Page|null>} popupPromise
 * @returns {Promise<import('playwright').Page|null>}
 */
async function adoptPopupIfPresent(session, popupPromise, options = {}) {
    const popup = await popupPromise;
    if (!popup) {
        return null;
    }

    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    await popup.waitForLoadState('networkidle', { timeout: BROWSER_DEFAULT_WAIT_TIMEOUT_MS }).catch(() => undefined);
    const popupUrl = String(popup.url() ?? '').trim().toLowerCase();
    if (!popupUrl || popupUrl === 'about:blank' || popupUrl.startsWith('data:') || popupUrl.startsWith('javascript:')) {
        await popup.close({ runBeforeUnload: false }).catch(() => undefined);
        return null;
    }

    const sourceUrl = String(options.sourceUrl ?? '').trim();
    const currentUrl = String(options.currentUrl ?? '').trim();
    const expectedUrl = String(options.expectedUrl ?? '').trim();
    const interactionKind = String(options.interactionKind ?? '').trim().toLowerCase();
    const clickedByCoordinates = options.clickedByCoordinates === true;
    const getHost = (value) => {
        try {
            return new URL(value).host.toLowerCase();
        } catch {
            return '';
        }
    };
    const normalizeComparableUrl = (value) => {
        try {
            const url = new URL(value);
            url.hash = '';
            return url.toString().toLowerCase();
        } catch {
            return String(value ?? '').trim().toLowerCase();
        }
    };
    const popupHost = getHost(popupUrl);
    const sourceHost = getHost(sourceUrl);
    const currentHost = getHost(currentUrl);
    const popupMatchesExpected = expectedUrl && normalizeComparableUrl(expectedUrl) === normalizeComparableUrl(popupUrl);
    const pageStayedOnSameHost = Boolean(sourceHost && currentHost && sourceHost === currentHost);
    const crossOriginPopup = Boolean(sourceHost && popupHost && sourceHost !== popupHost);
    const shouldCloseAsPopunder = !popupMatchesExpected && crossOriginPopup && pageStayedOnSameHost && (
        clickedByCoordinates || (interactionKind && interactionKind !== 'link')
    );

    if (shouldCloseAsPopunder) {
        await popup.close({ runBeforeUnload: false }).catch(() => undefined);
        return null;
    }

    trackSessionPage(session, popup);
    return popup;
}

/**
 * Saves a screenshot into the sandbox.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @param {import('playwright').Page} page
 * @param {string|null|undefined} filepath
 * @param {boolean} fullPage
 * @param {{ clickMarker?: { x: number, y: number } | null, persistGridMs?: number, persistClickMs?: number }} [options]
 * @returns {Promise<{ filepath: string }>}
 */
async function saveBrowserScreenshot(userHandle, workspace, character, page, filepath, fullPage = false, options = {}) {
    const fallbackFile = `browser/browser_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
    const output = await resolveSandboxWritePath(userHandle, workspace, character, filepath, fallbackFile);
    const overlayId = await addBrowserScreenshotOverlay(page, fullPage, options).catch(() => null);

    try {
        await page.screenshot({
            path: output.fullPath,
            fullPage,
            type: 'png',
        });
    } finally {
        if (overlayId && !((options.persistGridMs ?? BROWSER_SCREENSHOT_GRID_PERSIST_MS) > 0 || (options.persistClickMs ?? 0) > 0)) {
            await removeBrowserScreenshotOverlay(page, overlayId).catch(() => undefined);
        }
    }

    return { filepath: output.filepath };
}

/**
 * Injects a temporary coordinate grid overlay so screenshot-only workflows can estimate click positions more reliably.
 * @param {import('playwright').Page} page
 * @param {boolean} fullPage
 * @param {{ clickMarker?: { x: number, y: number } | null, persistGridMs?: number, persistClickMs?: number }} [options]
 * @returns {Promise<string>}
 */
async function addBrowserScreenshotOverlay(page, fullPage = false, options = {}) {
    const overlayId = `st-browser-screenshot-overlay-${crypto.randomBytes(6).toString('hex')}`;
    await page.evaluate(({ overlayId, fullPage, stepPx, majorStepPx, clickMarker, persistGridMs, persistClickMs }) => {
        const root = document.documentElement;
        const host = document.body || root;
        if (!root || !host) {
            throw new Error('No document root available for screenshot overlay.');
        }

        const width = fullPage
            ? Math.max(root.scrollWidth || 0, root.clientWidth || 0, window.innerWidth || 0)
            : Math.max(root.clientWidth || 0, window.innerWidth || 0);
        const height = fullPage
            ? Math.max(root.scrollHeight || 0, root.clientHeight || 0, window.innerHeight || 0)
            : Math.max(root.clientHeight || 0, window.innerHeight || 0);

        const overlay = document.createElement('div');
        overlay.id = overlayId;
        overlay.setAttribute('aria-hidden', 'true');

        Object.assign(overlay.style, {
            position: fullPage ? 'absolute' : 'fixed',
            left: '0',
            top: '0',
            width: `${width}px`,
            height: `${height}px`,
            pointerEvents: 'none',
            zIndex: '2147483647',
            boxSizing: 'border-box',
            overflow: 'hidden',
            backgroundImage: [
                'linear-gradient(to right, rgba(255, 32, 32, 0.38) 2px, transparent 2px)',
                'linear-gradient(to bottom, rgba(255, 32, 32, 0.38) 2px, transparent 2px)',
                'linear-gradient(to right, rgba(200, 0, 0, 0.72) 3px, transparent 3px)',
                'linear-gradient(to bottom, rgba(200, 0, 0, 0.72) 3px, transparent 3px)',
            ].join(','),
            backgroundSize: [
                `${stepPx}px ${stepPx}px`,
                `${stepPx}px ${stepPx}px`,
                `${majorStepPx}px ${majorStepPx}px`,
                `${majorStepPx}px ${majorStepPx}px`,
            ].join(','),
            backgroundPosition: '0 0, 0 0, 0 0, 0 0',
        });

        const labelLayer = document.createElement('div');
        labelLayer.dataset.overlayLayer = 'grid';
        Object.assign(labelLayer.style, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: '12px',
            lineHeight: '1',
            color: 'rgba(160, 0, 0, 0.98)',
            textShadow: '0 0 3px rgba(255, 255, 255, 0.98)',
        });

        const makeLabel = (text, left, top) => {
            const label = document.createElement('span');
            label.textContent = text;
            Object.assign(label.style, {
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                padding: '1px 3px',
                borderRadius: '2px',
                background: 'rgba(255, 255, 255, 0.72)',
                whiteSpace: 'nowrap',
            });
            return label;
        };

        for (let x = 0; x <= width; x += stepPx) {
            labelLayer.appendChild(makeLabel(String(x), Math.min(x + 2, Math.max(width - 36, 0)), 2));
        }

        for (let y = 0; y <= height; y += stepPx) {
            labelLayer.appendChild(makeLabel(String(y), 2, Math.min(y + 2, Math.max(height - 16, 0))));
        }

        overlay.appendChild(labelLayer);

        if (clickMarker && Number.isFinite(clickMarker.x) && Number.isFinite(clickMarker.y)) {
            const dot = document.createElement('div');
            dot.dataset.overlayLayer = 'click';
            Object.assign(dot.style, {
                position: 'absolute',
                left: `${clickMarker.x}px`,
                top: `${clickMarker.y}px`,
                width: '14px',
                height: '14px',
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                background: 'rgba(220, 0, 0, 0.92)',
                border: '2px solid rgba(255, 255, 255, 0.95)',
                boxShadow: '0 0 0 2px rgba(220, 0, 0, 0.25), 0 0 8px rgba(0, 0, 0, 0.35)',
            });

            const halo = document.createElement('div');
            halo.dataset.overlayLayer = 'click';
            Object.assign(halo.style, {
                position: 'absolute',
                left: `${clickMarker.x}px`,
                top: `${clickMarker.y}px`,
                width: '30px',
                height: '30px',
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                border: '2px solid rgba(220, 0, 0, 0.55)',
                background: 'rgba(255, 0, 0, 0.10)',
            });

            overlay.appendChild(halo);
            overlay.appendChild(dot);
        }

        host.appendChild(overlay);

        const removeOverlay = () => overlay.remove();
        const hideGrid = () => {
            overlay.querySelectorAll('[data-overlay-layer="grid"]').forEach(element => {
                if (element instanceof HTMLElement) {
                    element.style.opacity = '0';
                    element.style.transition = 'opacity 180ms ease';
                }
            });
        };
        const hideClick = () => {
            overlay.querySelectorAll('[data-overlay-layer="click"]').forEach(element => {
                if (element instanceof HTMLElement) {
                    element.style.opacity = '0';
                    element.style.transition = 'opacity 180ms ease';
                }
            });
        };

        if (persistGridMs > 0) {
            window.setTimeout(hideGrid, persistGridMs);
        }

        if (persistClickMs > 0) {
            window.setTimeout(hideClick, persistClickMs);
        }

        const removeAfterMs = Math.max(persistGridMs || 0, persistClickMs || 0);
        if (removeAfterMs > 0) {
            window.setTimeout(removeOverlay, removeAfterMs + 250);
        }
    }, {
        overlayId,
        fullPage,
        stepPx: BROWSER_SCREENSHOT_GRID_STEP_PX,
        majorStepPx: BROWSER_SCREENSHOT_GRID_MAJOR_STEP_PX,
        clickMarker: options.clickMarker ?? null,
        persistGridMs: Math.max(0, Number(options.persistGridMs ?? BROWSER_SCREENSHOT_GRID_PERSIST_MS) || 0),
        persistClickMs: Math.max(0, Number(options.persistClickMs ?? 0) || 0),
    });
    return overlayId;
}

/**
 * Removes the temporary screenshot coordinate overlay from a page.
 * @param {import('playwright').Page} page
 * @param {string} overlayId
 * @returns {Promise<void>}
 */
async function removeBrowserScreenshotOverlay(page, overlayId) {
    await page.evaluate(id => {
        document.getElementById(id)?.remove();
    }, overlayId);
}

/**
 * Formats a page result with tab metadata.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @param {object} [extra]
 * @returns {Promise<object>}
 */
async function formatBrowserPageResult(session, page, extra = {}) {
    return {
        session_id: session.id,
        tab_index: getSessionTabIndex(session, page),
        url: page.url(),
        title: await page.title(),
        tabs: await getSessionTabsSnapshot(session),
        ...extra,
    };
}

/**
 * Returns a small set of currently visible clickable elements and refreshes the server-side descriptor cache.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @param {number} [limit]
 * @returns {Promise<Array<{index:number,text:string,href?:string,kind?:string}>>}
 */
async function getClickableElementsSnapshot(session, page, limit = BROWSER_CLICKABLE_ELEMENTS_LIMIT) {
    const result = await collectDomFetch(page, {
        mode: 'interactive',
        limit,
        offset: 0,
    });
    if (Array.isArray(result?.descriptors)) {
        setSessionElementDescriptors(session, page, result.descriptors, result?.url || page.url());
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    return items.map(item => ({
        index: item.index,
        text: item.text,
        href: item.href,
        kind: item.kind,
    }));
}

/**
 * Builds a search URL for a supported engine.
 * @param {string} query
 * @param {string} engine
 * @returns {string}
 */
function buildBrowserSearchUrl(query, engine) {
    const normalizedEngine = String(engine ?? 'duckduckgo').trim().toLowerCase();
    const q = encodeURIComponent(String(query ?? '').trim());
    if (!q) {
        throw new Error('query is required.');
    }

    switch (normalizedEngine) {
        case 'duckduckgo':
        case 'ddg':
            return `https://duckduckgo.com/?q=${q}`;
        case 'brave':
            return `https://search.brave.com/search?q=${q}`;
        case 'bing':
            return `https://www.bing.com/search?q=${q}`;
        case 'google':
            return `https://www.google.com/search?q=${q}`;
        default:
            throw new Error('engine must be one of duckduckgo, brave, bing, or google.');
    }
}

/**
 * Normalizes an element index value.
 * @param {unknown} elementIndex
 * @returns {number|null}
 */
function normalizeElementIndex(elementIndex) {
    if (elementIndex === null || typeof elementIndex === 'undefined' || String(elementIndex).trim() === '') {
        return null;
    }

    const index = Number(elementIndex);
    if (!Number.isInteger(index) || index < 0) {
        throw new Error('element_index must be a non-negative integer.');
    }

    return index;
}

/**
 * Infers which DOM fetch mode produced the current cached descriptors.
 * @param {Array<{kind:string}>} descriptors
 * @returns {'interactive'|'links'|null}
 */
function inferCachedDescriptorMode(descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
        return null;
    }

    return descriptors.some(item => item.kind !== 'link') ? 'interactive' : 'links';
}

/**
 * Rebuilds the cached descriptors for the current page and tries to find a requested element index.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @param {number} index
 * @param {'interactive'|'links'|null} preferredMode
 * @returns {Promise<{index:number,selector:string,frameIndex:number,kind:string,text:string,href?:string,x?:number,y?:number,width?:number,height?:number}|null>}
 */
async function rebuildCachedElementDescriptor(session, page, index, preferredMode = null) {
    const cachedDescriptors = session.elementCache.get(page) ?? [];
    const desiredLimit = Math.min(
        Math.max(index + 1, cachedDescriptors.length, BROWSER_LIST_DEFAULT_LIMIT),
        BROWSER_LIST_MAX_LIMIT,
    );
    const modes = preferredMode
        ? [preferredMode, preferredMode === 'interactive' ? 'links' : 'interactive']
        : ['interactive', 'links'];

    for (const mode of modes) {
        const result = await collectDomFetch(page, {
            mode,
            limit: desiredLimit,
            offset: 0,
        });
        const descriptors = Array.isArray(result?.descriptors) ? result.descriptors : [];
        if (descriptors.length > 0) {
            setSessionElementDescriptors(session, page, descriptors, result?.url || page.url());
        }

        const descriptor = descriptors.find(item => item.index === index);
        if (descriptor) {
            return descriptor;
        }
    }

    return null;
}

/**
 * Resolves a cached element descriptor by number for a page, rebuilding the cache when needed.
 * @param {BrowserSession} session
 * @param {import('playwright').Page} page
 * @param {unknown} elementIndex
 * @param {{ forceRefresh?: boolean, refreshIfMissing?: boolean }} [options]
 * @returns {Promise<{index:number,selector:string,frameIndex:number,kind:string,text:string,href?:string,x?:number,y?:number,width?:number,height?:number}|null>}
 */
async function getCachedElementDescriptor(session, page, elementIndex, options = {}) {
    const index = normalizeElementIndex(elementIndex);
    if (index === null) {
        return null;
    }

    const cachedDescriptors = session.elementCache.get(page) ?? [];
    const staleSnapshot = session.staleElementCache.get(page);
    if (!options.forceRefresh) {
        const descriptor = cachedDescriptors.find(item => item.index === index);
        if (descriptor) {
            return descriptor;
        }
    }

    if (!options.forceRefresh && cachedDescriptors.length === 0 && staleSnapshot?.descriptors?.length) {
        const staleUrl = String(staleSnapshot?.url ?? '').trim();
        const currentUrl = String(page.url() ?? '').trim();
        const warning = staleUrl && currentUrl && staleUrl !== currentUrl
            ? `element_index ${index} is stale because the page changed from "${staleUrl}" to "${currentUrl}".`
            : `element_index ${index} is stale because the page changed after it was cached.`;
        const error = new Error(`${warning} Run dom_fetch again and use one of the new indices.`);
        error.browserWarnings = [warning];
        throw error;
    }

    if (options.refreshIfMissing === false) {
        throw new Error(`No cached element found for element_index ${index}. Run dom_fetch in links or interactive mode for this tab first.`);
    }

    const preferredMode = inferCachedDescriptorMode(cachedDescriptors);
    const descriptor = await rebuildCachedElementDescriptor(session, page, index, preferredMode);
    if (!descriptor) {
        const staleDescriptor = staleSnapshot?.descriptors?.find(item => item.index === index);
        if (staleDescriptor) {
            const staleUrl = String(staleSnapshot?.url ?? '').trim();
            const currentUrl = String(page.url() ?? '').trim();
            const warning = staleUrl && currentUrl && staleUrl !== currentUrl
                ? `element_index ${index} is stale because the page changed from "${staleUrl}" to "${currentUrl}".`
                : `element_index ${index} is stale because the page changed after it was cached.`;
            const error = new Error(`${warning} Run dom_fetch again and use one of the new indices.`);
            error.browserWarnings = [warning];
            throw error;
        }

        throw new Error(`No element found for element_index ${index} on the current page. Run dom_fetch in interactive or links mode and choose one of the returned indices.`);
    }

    return descriptor;
}

/**
 * Finds a locator from a cached element descriptor.
 * @param {import('playwright').Page} page
 * @param {{selector:string,frameIndex:number}} descriptor
 * @returns {Promise<{ frame: import('playwright').Frame, locator: import('playwright').Locator }>}
 */
async function findDescriptorLocator(page, descriptor) {
    const frames = page.frames();
    const frame = frames[descriptor.frameIndex];
    if (!frame) {
        throw new Error('The cached element frame is no longer available. Run dom_fetch again.');
    }

    const locator = frame.locator(descriptor.selector).first();
    if (await locator.count() === 0) {
        throw new Error('The cached element is no longer available. Run dom_fetch again.');
    }

    return { frame, locator };
}

/**
 * Adds viewport-relative bounding boxes and click points to DOM descriptors.
 * @param {import('playwright').Page} page
 * @param {Array<{index:number, selector:string, frameIndex:number, kind:string, text:string, href?:string}>} descriptors
 * @returns {Promise<Array<{index:number, selector:string, frameIndex:number, kind:string, text:string, href?:string, x?:number, y?:number, width?:number, height?:number}>>}
 */
async function enrichDescriptorsWithGeometry(page, descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
        return [];
    }

    const enriched = [];
    for (const descriptor of descriptors) {
        try {
            const { locator } = await findDescriptorLocator(page, descriptor);
            const box = await locator.boundingBox();
            if (!box) {
                enriched.push(descriptor);
                continue;
            }

            enriched.push({
                ...descriptor,
                x: Math.round(box.x + (box.width / 2)),
                y: Math.round(box.y + (box.height / 2)),
                width: Math.round(box.width),
                height: Math.round(box.height),
            });
        } catch {
            enriched.push(descriptor);
        }
    }

    return enriched;
}

/**
 * Extracts lightweight interaction metadata from a resolved locator.
 * @param {import('playwright').Locator} locator
 * @returns {Promise<{ kind: string, href?: string }>}
 */
async function getLocatorInteractionMetadata(locator) {
    try {
        return await locator.evaluate(element => {
            const tagName = element.tagName?.toLowerCase?.() || '';
            if (element instanceof HTMLAnchorElement) {
                return {
                    kind: 'link',
                    href: element.href || '',
                };
            }

            if (tagName === 'button' || element.getAttribute('role') === 'button') {
                return { kind: 'button' };
            }

            return { kind: 'interactive' };
        });
    } catch {
        return { kind: 'interactive' };
    }
}

/**
 * Computes a viewport click point for a locator so the result screenshot can show where the click landed.
 * @param {import('playwright').Locator} locator
 * @returns {Promise<{x:number,y:number}|null>}
 */
async function getLocatorClickPoint(locator) {
    try {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
        const box = await locator.boundingBox();
        if (!box) {
            return null;
        }

        return {
            x: Math.round(box.x + (box.width / 2)),
            y: Math.round(box.y + (box.height / 2)),
        };
    } catch {
        return null;
    }
}

/**
 * Resolves a locator for browser interactions. When both selector and element_index are provided,
 * prefer the selector and fall back to the cached descriptor if needed.
 * @param {import('playwright').Page} page
 * @param {BrowserSession} session
 * @param {string} selector
 * @param {unknown} elementIndex
 * @returns {Promise<{ frame: import('playwright').Frame, locator: import('playwright').Locator }>}
 */
async function resolveInteractionLocator(page, session, selector, elementIndex, text, textIndex = null) {
    const trimmedSelector = String(selector ?? '').trim();
    const trimmedText = String(text ?? '').trim();
    const hasSelector = Boolean(trimmedSelector);
    const hasText = Boolean(trimmedText);
    const hasDescriptor = elementIndex !== null && typeof elementIndex !== 'undefined' && String(elementIndex).trim() !== '';

    if (hasSelector) {
        try {
            return await findFrameLocator(page, normalizeSelector(trimmedSelector), BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
        } catch (selectorError) {
            if (!hasText && !hasDescriptor) {
                throw selectorError;
            }
        }
    }

    if (hasText) {
        try {
            return await findFrameLocatorByText(page, normalizeVisibleText(trimmedText), BROWSER_DEFAULT_WAIT_TIMEOUT_MS, textIndex);
        } catch (textError) {
            if (!hasDescriptor) {
                throw textError;
            }
        }
    }

    try {
        const descriptor = await getCachedElementDescriptor(session, page, elementIndex);
        if (descriptor) {
            return await findDescriptorLocator(page, descriptor);
        }
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error).toLowerCase();
        const shouldRefreshCache = [
            'no cached element found for element_index',
            'the cached element frame is no longer available',
            'the cached element is no longer available',
        ].some(marker => message.includes(marker));

        if (!shouldRefreshCache) {
            throw error;
        }

        const descriptor = await getCachedElementDescriptor(session, page, elementIndex, { forceRefresh: true });
        if (descriptor) {
            return await findDescriptorLocator(page, descriptor);
        }
    }

    throw new Error('Provide selector, text, element_index, or both x and y.');
}

/**
 * Clicks a locator with fallbacks for overlays and unstable targets.
 * @param {import('playwright').Locator} locator
 * @param {'left'|'middle'|'right'} [button]
 * @returns {Promise<void>}
 */
async function clickLocatorReliably(locator, button = 'left') {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.hover({ timeout: Math.min(BROWSER_DEFAULT_WAIT_TIMEOUT_MS, 3_000) }).catch(() => undefined);
    await locator.focus().catch(() => undefined);

    try {
        await locator.click({ timeout: BROWSER_DEFAULT_WAIT_TIMEOUT_MS, button });
        return;
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error).toLowerCase();
        const shouldForceClick = [
            'intercepts pointer events',
            'element is not visible',
            'element is outside of the viewport',
            'another element',
            'timeout',
        ].some(marker => message.includes(marker));

        if (!shouldForceClick) {
            throw error;
        }
    }

    try {
        await locator.click({ timeout: 5_000, force: true, button });
        return;
    } catch {
        const box = await locator.boundingBox();
        if (button !== 'left') {
            if (!box) {
                throw new Error('Resolved element is not clickable.');
            }

            const clickX = box.x + box.width / 2;
            const clickY = box.y + box.height / 2;
            const page = locator.page();
            await page.mouse.move(clickX, clickY).catch(() => undefined);
            await page.mouse.click(clickX, clickY, { button }).catch(() => undefined);
            await locator.evaluate((element, point) => {
                if (!(element instanceof Element)) {
                    throw new Error('Resolved element is not clickable.');
                }

                const eventInit = {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    button: 2,
                    buttons: 2,
                    clientX: point.clientX,
                    clientY: point.clientY,
                    view: window,
                };
                element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
                element.dispatchEvent(new MouseEvent('mousedown', eventInit));
                element.dispatchEvent(new MouseEvent('contextmenu', eventInit));
                element.dispatchEvent(new MouseEvent('mouseup', eventInit));
                element.dispatchEvent(new PointerEvent('pointerup', eventInit));
            }, { clientX: Math.round(clickX), clientY: Math.round(clickY) }).catch(() => undefined);
            return;
        }

        await locator.evaluate(element => {
            if (element instanceof HTMLElement) {
                element.click();
                return;
            }
            throw new Error('Resolved element is not clickable.');
        });
    }
}

async function dispatchSyntheticContextMenu(locator, clickPoint = null) {
    const box = await locator.boundingBox();
    if (!box && !clickPoint) {
        throw new Error('Resolved element is not clickable.');
    }

    const clientX = Math.round(clickPoint?.x ?? (box.x + box.width / 2));
    const clientY = Math.round(clickPoint?.y ?? (box.y + box.height / 2));
    await locator.evaluate((element, point) => {
        if (!(element instanceof Element)) {
            throw new Error('Resolved element is not clickable.');
        }

        const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 2,
            buttons: 2,
            clientX: point.clientX,
            clientY: point.clientY,
            view: window,
        };
        element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        element.dispatchEvent(new MouseEvent('mousedown', eventInit));
        element.dispatchEvent(new MouseEvent('contextmenu', eventInit));
        element.dispatchEvent(new MouseEvent('mouseup', eventInit));
        element.dispatchEvent(new PointerEvent('pointerup', eventInit));
    }, { clientX, clientY });
}

/**
 * Detects common anti-bot or captcha interstitial markers.
 * @param {import('playwright').Page} page
 * @returns {Promise<object|null>}
 */
async function detectPageInterstitial(page) {
    try {
        const snapshot = await page.evaluate(() => ({
            title: globalThis.document.title || '',
            bodyText: globalThis.document.body?.innerText?.slice(0, 4000) || '',
        }));
        const haystack = `${snapshot.title}\n${snapshot.bodyText}`.toLowerCase();
        const markers = [
            'captcha',
            'verify you are human',
            'are you human',
            'cloudflare',
            'attention required',
            'press and hold',
            'unusual traffic',
        ];
        const match = markers.find(marker => haystack.includes(marker));

        if (!match) {
            return null;
        }

        return {
            type: 'interstitial',
            marker: match,
            title: snapshot.title,
            url: page.url(),
        };
    } catch {
        return null;
    }
}

/**
 * Collects DOM content from the active page.
 * @param {import('playwright').Page} page
 * @param {{ mode?: string, selector?: string, max_chars?: number }} options
 * @returns {Promise<any>}
 */
async function collectDomFetch(page, options = {}) {
    const mode = String(options.mode ?? 'readable').trim().toLowerCase();
    const selector = typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : null;
    const maxChars = Math.min(Math.max(Number(options.max_chars) || DOM_FETCH_DEFAULT_MAX_CHARS, 1), DOM_FETCH_MAX_CHARS);
    const limit = Math.min(Math.max(Number(options.limit) || BROWSER_LIST_DEFAULT_LIMIT, 1), BROWSER_LIST_MAX_LIMIT);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const target = selector
        ? (await findFrameLocator(page, selector, BROWSER_DEFAULT_WAIT_TIMEOUT_MS)).frame
        : page.mainFrame();
    const frameIndex = page.frames().indexOf(target);

    const result = await target.evaluate(({ selector, mode, maxChars, limit, offset }) => {
        const normalizeText = (value) => String(value ?? '')
            .replace(/\r/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const clampText = (value) => {
            const text = String(value ?? '');
            return text.length > maxChars ? `${text.slice(0, maxChars)}\n... (truncated)` : text;
        };

        const getRoot = () => {
            if (!selector) {
                return globalThis.document.body || globalThis.document.documentElement;
            }

            const element = globalThis.document.querySelector(selector);
            if (!element) {
                throw new Error(`No element matched selector "${selector}".`);
            }
            return element;
        };

        const getVisibleText = (element) => normalizeText(element?.innerText || element?.textContent || '');
        const sanitizeClone = (element) => {
            const clone = element.cloneNode(true);
            clone.querySelectorAll?.('script, style, noscript').forEach(node => node.remove());
            return clone;
        };
        const escapeCss = (value) => {
            if (globalThis.CSS?.escape) {
                return globalThis.CSS.escape(value);
            }
            return String(value).replace(/["\\]/g, '\\$&');
        };
        const getCssPath = (element) => {
            if (!(element instanceof globalThis.Element)) {
                return null;
            }
            if (element.id) {
                return `#${escapeCss(element.id)}`;
            }

            const segments = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== globalThis.document.body) {
                let segment = current.tagName.toLowerCase();
                const classes = Array.from(current.classList || []).slice(0, 2).map(className => `.${escapeCss(className)}`).join('');
                if (classes) {
                    segment += classes;
                } else if (current.parentElement) {
                    const siblings = Array.from(current.parentElement.children).filter(node => node.tagName === current.tagName);
                    if (siblings.length > 1) {
                        segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                    }
                }

                segments.unshift(segment);
                current = current.parentElement;
            }

            return segments.join(' > ');
        };
        const collectInteractiveItems = (root, interactiveMode) => {
            const selectorList = interactiveMode
                ? 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [tabindex]'
                : 'a[href]';
            const candidates = Array.from(root.querySelectorAll(selectorList));
            const filtered = candidates.filter(element => {
                const rect = element.getBoundingClientRect();
                const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.value || '');
                const viewportWidth = globalThis.innerWidth || globalThis.document.documentElement?.clientWidth || 0;
                const viewportHeight = globalThis.innerHeight || globalThis.document.documentElement?.clientHeight || 0;
                const intersectsViewport = rect.bottom > 0
                    && rect.right > 0
                    && rect.top < viewportHeight
                    && rect.left < viewportWidth;
                return rect.width > 0 && rect.height > 0 && intersectsViewport && text;
            });

            return filtered.slice(offset, offset + limit).map((element, index) => ({
                index: offset + index,
                tag: element.tagName.toLowerCase(),
                kind: interactiveMode ? (element.tagName.toLowerCase() === 'a' ? 'link' : 'interactive') : 'link',
                text: normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.value || ''),
                href: element instanceof HTMLAnchorElement ? element.href : undefined,
                selector: getCssPath(element),
            })).filter(item => item.selector);
        };

        const root = getRoot();

        if (mode === 'html') {
            const clone = sanitizeClone(root);
            return {
                mode: 'html',
                url: globalThis.location.href,
                title: globalThis.document.title,
                selector,
                html: clampText(clone.outerHTML || ''),
            };
        }

        if (mode === 'text') {
            return {
                mode: 'text',
                url: globalThis.location.href,
                title: globalThis.document.title,
                selector,
                text: clampText(getVisibleText(root)),
            };
        }

        if (mode === 'links') {
            const linkRoot = selector ? root : globalThis.document;
            const links = collectInteractiveItems(linkRoot, false);

            return {
                mode: 'links',
                url: globalThis.location.href,
                title: globalThis.document.title,
                selector,
                offset,
                limit,
                links,
                descriptors: links.map(({ index, selector: itemSelector, kind, text, href }) => ({ index, selector: itemSelector, kind, text, href })),
            };
        }

        if (mode === 'interactive') {
            const interactiveRoot = selector ? root : globalThis.document;
            const items = collectInteractiveItems(interactiveRoot, true);

            return {
                mode: 'interactive',
                url: globalThis.location.href,
                title: globalThis.document.title,
                selector,
                offset,
                limit,
                items,
                descriptors: items.map(({ index, selector: itemSelector, kind, text, href }) => ({ index, selector: itemSelector, kind, text, href })),
            };
        }

        const readableCandidates = selector
            ? [root]
            : [
                globalThis.document.querySelector('article'),
                globalThis.document.querySelector('main'),
                globalThis.document.querySelector('[role="main"]'),
                ...Array.from(globalThis.document.querySelectorAll('.article, .post, .entry-content, .post-content, .article-body, .content, .main-content')).slice(0, 8),
                globalThis.document.body || globalThis.document.documentElement,
            ].filter(Boolean);

        let best = readableCandidates[0] || root;
        let bestText = getVisibleText(best);
        for (const candidate of readableCandidates.slice(1)) {
            const candidateText = getVisibleText(candidate);
            if (candidateText.length > bestText.length) {
                best = candidate;
                bestText = candidateText;
            }
        }

        return {
            mode: 'readable',
            url: globalThis.location.href,
            title: globalThis.document.title,
            selector,
            text: clampText(bestText),
        };
    }, { selector, mode, maxChars, limit, offset });

    if (Array.isArray(result?.descriptors)) {
        result.descriptors = result.descriptors.map(item => ({ ...item, frameIndex }));
        result.descriptors = await enrichDescriptorsWithGeometry(page, result.descriptors);
        const geometryByIndex = new Map(result.descriptors.map(item => [item.index, item]));

        if (Array.isArray(result.items)) {
            result.items = result.items.map(item => {
                const geometry = geometryByIndex.get(item.index);
                return geometry ? {
                    ...item,
                    x: geometry.x,
                    y: geometry.y,
                    width: geometry.width,
                    height: geometry.height,
                } : item;
            });
        }

        if (Array.isArray(result.links)) {
            result.links = result.links.map(item => {
                const geometry = geometryByIndex.get(item.index);
                return geometry ? {
                    ...item,
                    x: geometry.x,
                    y: geometry.y,
                    width: geometry.width,
                    height: geometry.height,
                } : item;
            });
        }
    }

    return result;
}

/**
 * Evaluates user-provided JavaScript in the page context and returns a JSON-safe result.
 * @param {import('playwright').Page} page
 * @param {{ code: string, selector?: string, arg?: any }} options
 * @returns {Promise<any>}
 */
async function executePageJavaScript(page, options) {
    const code = String(options.code ?? '').trim();
    const selector = typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : null;
    const arg = options.arg ?? null;

    if (!code) {
        throw new Error('code is required.');
    }

    const target = selector
        ? (await findFrameLocator(page, selector, BROWSER_DEFAULT_WAIT_TIMEOUT_MS)).frame
        : page.mainFrame();

    const result = await target.evaluate(({ selector, code, arg }) => {
        const run = async () => {
            let element = null;
            if (selector) {
                element = globalThis.document.querySelector(selector);
                if (!element) {
                    throw new Error(`No element matched selector "${selector}".`);
                }
            }

            const snapshotFormFields = () => {
                const elements = Array.from(globalThis.document.querySelectorAll('input, textarea, select'));
                return elements.map((field, index) => {
                    const tag = field.tagName.toLowerCase();
                    const name = field.getAttribute('name') || '';
                    const id = field.getAttribute('id') || '';
                    const type = field instanceof HTMLInputElement ? (field.type || 'text') : tag;
                    const key = id || name || `${tag}:${index}`;
                    let value = null;

                    if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) {
                        value = field.checked;
                    } else if (field instanceof HTMLSelectElement && field.multiple) {
                        value = Array.from(field.selectedOptions).map(option => option.value);
                    } else if ('value' in field) {
                        value = field.value;
                    }

                    return { key, tag, type, name, id, value };
                });
            };

            const $ = (query, root = globalThis.document) => root.querySelector(query);
            const $$ = (query, root = globalThis.document) => Array.from(root.querySelectorAll(query));
            const fn = new Function('element', 'arg', '$', '$$', `
                'use strict';
                return (async () => {
                    ${code}
                })();
            `);

            const beforeFields = snapshotFormFields();
            const value = await fn(element, arg, $, $$);
            const afterFields = snapshotFormFields();
            const beforeValues = new Map(beforeFields.map(field => [field.key, JSON.stringify(field.value)]));
            const changedFields = afterFields
                .filter(field => beforeValues.get(field.key) !== JSON.stringify(field.value))
                .map(({ key, tag, type, name, id, value }) => ({ key, tag, type, name, id, value }));

            return JSON.parse(JSON.stringify({
                value,
                changed_fields: changedFields,
            }));
        };

        return run();
    }, { selector, code, arg });

    const serialized = JSON.stringify(result);
    if (serialized.length > EXECUTE_JS_RESULT_MAX_CHARS) {
        throw new Error(`execute_js result is too large. Max serialized size is ${EXECUTE_JS_RESULT_MAX_CHARS} characters.`);
    }

    return result;
}

router.get('/workspaces', async (req, res) => {
    try {
        const userSandboxRoot = getUserSandboxRootDir(req.user.profile.handle);
        await fs.mkdir(userSandboxRoot, { recursive: true });
        const dirents = await fs.readdir(userSandboxRoot, { withFileTypes: true });
        const workspaces = dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .sort((a, b) => a.localeCompare(b));

        return res.json({ workspaces, rootPath: userSandboxRoot });
    } catch (error) {
        console.error('Error listing workspaces:', error);
        return res.status(500).json({ error: 'An error occurred while listing workspaces.' });
    }
});

router.get('/download', async (req, res) => {
    let filepath = req.query.file;
    const workspace = req.query.workspace;
    const character = req.query.character;
    const downloadParam = String(req.query.download ?? '').toLowerCase();
    const forceDownload = ['1', 'true', 'yes', 'on'].includes(downloadParam);

    if (!filepath || typeof filepath !== 'string') {
        return res.status(400).json({ error: 'file query parameter is required.' });
    }

    try {
        const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);
        const fullPath = path.resolve(sandboxDir, filepath);
        const fileName = path.basename(fullPath);
        const onSendComplete = (error) => {
            if (!error) {
                return;
            }

            if (error.code === 'ENOENT') {
                res.status(404).json({ error: `File not found: ${filepath}` });
            } else if (!res.headersSent) {
                console.error(`Error downloading file "${filepath}":`, error);
                res.status(500).json({ error: 'An error occurred while downloading the file.' });
            }
        };

        if (forceDownload) {
            return res.download(fullPath, fileName, onSendComplete);
        }

        return res.sendFile(fullPath, onSendComplete);
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `File not found: ${filepath}` });
        } else {
            console.error(`Error downloading file "${filepath}":`, error);
            res.status(500).json({ error: 'An error occurred while downloading the file.' });
        }
    }
});

router.post('/media-info', async (req, res) => {
    const { filepath, workspace, character, allowVideo = false } = req.body ?? {};

    try {
        const info = await inspectSandboxMediaFile(
            req.user.profile.handle,
            workspace,
            character,
            filepath,
            { allowVideo: allowVideo === true || allowVideo === 'true' },
        );
        return res.json(info);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'An error occurred while validating the media file.';
        if (message.startsWith('Access denied:')) {
            return res.status(403).json({ error: message });
        }
        if (message === 'filepath is required.') {
            return res.status(400).json({ error: message });
        }
        if (String(error?.code ?? '') === 'ENOENT') {
            return res.status(404).json({ error: `File not found: ${String(filepath ?? '').trim()}` });
        }
        console.error(`Error validating media file "${String(filepath ?? '').trim()}":`, error);
        return res.status(400).json({ error: message });
    }
});

router.post('/readfile', async (req, res) => {
    let { filepath, workspace, character } = req.body;

    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required.' });
    }

    try {
        const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);
        const fullPath = path.resolve(sandboxDir, filepath);
        await fs.mkdir(sandboxDir, { recursive: true });
        const content = await fs.readFile(fullPath, 'utf-8');
        res.json({ content });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `File not found: ${filepath}` });
        } else {
            console.error(`Error reading file "${filepath}":`, error);
            res.status(500).json({ error: 'An error occurred while reading the file.' });
        }
    }
});

router.post('/listdir', async (req, res) => {
    let { path: dirPath = '.', workspace, character } = req.body;
    const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);

    try {
        await fs.mkdir(sandboxDir, { recursive: true });
    } catch (error) {
        console.error(`Error creating sandbox directory "${sandboxDir}":`, error);
        return res.status(500).json({ error: 'An error occurred while preparing the sandbox directory.' });
    }

    try {
        const fullPath = path.resolve(sandboxDir, dirPath);
        const dirents = await fs.readdir(fullPath, { withFileTypes: true });

        const files = [];
        const directories = [];

        for (const dirent of dirents) {
            if (dirent.isDirectory()) {
                directories.push(dirent.name);
            } else {
                files.push(dirent.name);
            }
        }

        res.json({ files, directories });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `Directory not found: ${dirPath}` });
        } else {
            console.error(`Error listing directory "${dirPath}":`, error);
            res.status(500).json({ error: 'An error occurred while listing the directory.' });
        }
    }
});

router.post('/writefile', async (req, res) => {
    let { filepath, content, overwrite, append, workspace, character } = req.body;
    const shouldOverwrite = overwrite === true || overwrite === 'true'
        || ((overwrite === undefined || overwrite === null || overwrite === '') && (append === false || append === 'false'));

    if (!filepath || typeof content !== 'string') {
        return res.status(400).json({ error: 'filepath and content are required.' });
    }

    try {
        const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);
        const fullPath = path.resolve(sandboxDir, filepath);
        const dir = path.dirname(fullPath);

        await fs.mkdir(dir, { recursive: true });

        const flag = shouldOverwrite ? 'w' : 'a';
        await fs.writeFile(fullPath, content, { flag });

        const bytesWritten = Buffer.byteLength(content, 'utf8');
        res.json({ message: `Successfully ${shouldOverwrite ? 'wrote' : 'appended'} ${bytesWritten} bytes to ${filepath}` });
    } catch (error) {
        console.error(`Error writing file "${filepath}":`, error);
        res.status(500).json({ error: 'An error occurred while writing the file.' });
    }
});

/**
 * Best-effort extraction of the first invoked command from a PowerShell command string.
 * This is only used for the denylist check.
 * @param {string} command
 * @returns {string}
 */
function getPowerShellCommandCandidate(command) {
    const trimmedCommand = String(command ?? '').trim();
    if (!trimmedCommand) {
        return '';
    }

    const normalizedCommand = trimmedCommand.replace(/^&\s*/, '');
    const commandMatch = normalizedCommand.match(/^(['"]?)([^'"`\s|&;><()]+)\1/);
    if (!commandMatch) {
        return '';
    }

    return path.basename(commandMatch[2]).toLowerCase();
}

/**
 * Extracts the first non-switch argument from a delete command.
 * This is used to reject filesystem-root wipeouts while still allowing
 * normal file deletion.
 * @param {string} command
 * @returns {string}
 */
function getDeleteTargetCandidate(command) {
    const trimmedCommand = String(command ?? '').trim();
    if (!trimmedCommand) {
        return '';
    }

    const tokens = trimmedCommand
        .replace(/^&\s*/, '')
        .match(/(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s]+)/g) || [];

    if (tokens.length < 2) {
        return '';
    }

    for (const token of tokens.slice(1)) {
        const lowerToken = token.toLowerCase();
        if (lowerToken.startsWith('-')) {
            continue;
        }

        if (/^\/[a-z]$/i.test(lowerToken)) {
            continue;
        }

        return token.replace(/^['"`]|['"`]$/g, '');
    }

    return '';
}

/**
 * Detects obvious "wipe the whole disk" delete commands like `rm -rf /*`.
 * Normal file deletes are allowed.
 * @param {string} command
 * @returns {boolean}
 */
function isDestructiveDeleteCommand(command) {
    const candidate = getPowerShellCommandCandidate(command);
    if (!DESTRUCTIVE_DELETE_COMMANDS.has(candidate)) {
        return false;
    }

    const target = getDeleteTargetCandidate(command).trim();
    if (!target) {
        return false;
    }

    return /^(?:\/\*|\/|\.|\.{2}|\*|\.\/\*|\.\\\*|\.\.\/\*|\.\.\\\*|[a-z]:[\\/]\*?|[a-z]:[\\/])$/i.test(target);
}

/**
 * Builds PowerShell arguments that force UTF-8 I/O before running the user command.
 * @param {string} command
 * @returns {string[]}
 */
function buildPowerShellInvocationArgs(command) {
    const script = `${POWERSHELL_UTF8_PREAMBLE}; & {\n${command}\n}`;
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand];
}

/**
 * Filters PowerShell CLIXML progress noise from stderr while preserving normal text.
 * @param {{ cliXmlBuffer?: string|null }} shellProcess
 * @param {string} chunk
 * @returns {string}
 */
function filterPowerShellStderrChunk(shellProcess, chunk) {
    const stderrChunk = String(chunk ?? '');
    if (!stderrChunk) {
        return '';
    }

    const existingBuffer = typeof shellProcess.cliXmlBuffer === 'string' ? shellProcess.cliXmlBuffer : '';
    const startIndex = existingBuffer
        ? 0
        : stderrChunk.indexOf('#< CLIXML');

    if (!existingBuffer && startIndex === -1) {
        return stderrChunk;
    }

    const prefix = existingBuffer
        ? ''
        : stderrChunk.slice(0, startIndex);
    let buffer = existingBuffer
        ? `${existingBuffer}${stderrChunk}`
        : `${stderrChunk.slice(startIndex)}`;

    const endTag = '</Objs>';
    const endIndex = buffer.indexOf(endTag);
    if (endIndex === -1) {
        shellProcess.cliXmlBuffer = buffer;
        return prefix;
    }

    const xmlEndIndex = endIndex + endTag.length;
    const cliXmlPayload = buffer.slice(0, xmlEndIndex);
    const suffix = buffer.slice(xmlEndIndex);
    shellProcess.cliXmlBuffer = '';

    const sanitizedPayload = cliXmlPayload.replace(/^#< CLIXML\r?\n?/, '').trim();
    const shouldSuppress = /<Obj\b[^>]*\sS="progress"/i.test(sanitizedPayload)
        || /<PR\b[^>]*\sN="Record"/i.test(sanitizedPayload);

    const preservedCliXml = shouldSuppress ? '' : cliXmlPayload;
    return `${prefix}${preservedCliXml}${filterPowerShellStderrChunk(shellProcess, suffix)}`;
}

/**
 * Writes a structured shell execution event to the streaming response.
 * @param {express.Response} res
 * @param {Record<string, any>} payload
 */
function writeShellEvent(res, payload) {
    if (res.writableEnded || res.destroyed) {
        return;
    }

    res.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Stops the currently tracked shell process, if any.
 * @param {string} reason
 * @param {string} [expectedRunId]
 * @returns {boolean}
 */
function stopActiveShellProcess(reason, expectedRunId) {
    const activeShell = activeProcesses.shell;
    if (!activeShell) {
        return false;
    }

    if (expectedRunId && activeShell.runId !== expectedRunId) {
        return false;
    }

    if (activeShell.stopRequested) {
        return true;
    }

    activeShell.stopRequested = true;
    activeShell.stopReason = reason;

    if (!activeShell.childProcess.killed) {
        activeShell.childProcess.kill();
    }

    return true;
}

/**
 * Stops the currently tracked Python process, if any.
 * @param {string} reason
 * @param {string} [expectedRunId]
 * @returns {boolean}
 */
function stopActivePythonProcess(reason, expectedRunId) {
    const activePython = activeProcesses.python;
    if (!activePython) {
        return false;
    }

    if (expectedRunId && activePython.runId !== expectedRunId) {
        return false;
    }

    if (activePython.stopRequested) {
        return true;
    }

    activePython.stopRequested = true;
    activePython.stopReason = reason;
    activePython.timedOut = reason === 'timed_out';

    if (!activePython.childProcess.killed) {
        activePython.childProcess.kill();
    }

    return true;
}

/**
 * Resolves and validates the requested shell working directory.
 * @param {string} userHandle
 * @param {unknown} workspace
 * @param {unknown} character
 * @param {unknown} cwd
 * @returns {Promise<{ sandboxDir: string, workingDir: string, displayCwd: string }>}
 */
async function resolveShellWorkingDirectory(userHandle, workspace, character, cwd) {
    const sandboxDir = getSandboxDir(userHandle, workspace, character);
    await fs.mkdir(sandboxDir, { recursive: true });

    if (cwd === undefined || cwd === null || String(cwd).trim() === '') {
        return {
            sandboxDir,
            workingDir: sandboxDir,
            displayCwd: '.',
        };
    }

    if (typeof cwd !== 'string') {
        const error = new Error('cwd must be a string.');
        error.statusCode = 400;
        throw error;
    }

    const workingDir = path.resolve(sandboxDir, cwd);
    const stat = await fs.stat(workingDir);
    if (!stat.isDirectory()) {
        const error = new Error('cwd must point to a directory.');
        error.statusCode = 400;
        throw error;
    }

    return {
        sandboxDir,
        workingDir,
        displayCwd: workingDir.replaceAll('\\', '/'),
    };
}

router.post('/executeshell', async (req, res) => {
    const { command, explanation, cwd, workspace, character } = req.body ?? {};

    if (typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ error: 'command is required.' });
    }

    if (typeof explanation !== 'string' || !explanation.trim()) {
        return res.status(400).json({ error: 'explanation is required and must describe what the command does.' });
    }

    if (isDestructiveDeleteCommand(command)) {
        const errorMessage = 'Error: Deleting the filesystem root or using wildcard wipe commands is forbidden for security reasons.';
        console.warn(`Blocked destructive delete command: ${command}`);
        return res.status(403).json({ error: errorMessage });
    }

    const normalizedCandidate = getPowerShellCommandCandidate(command);
    if (normalizedCandidate && COMMAND_DENYLIST.has(normalizedCandidate)) {
        const errorMessage = `Error: The command "${normalizedCandidate}" is forbidden for security reasons.`;
        console.warn(`Blocked forbidden command: ${command}`);
        return res.status(403).json({ error: errorMessage });
    }

    let sandboxDir;
    let workingDir;
    let displayCwd;
    try {
        ({ sandboxDir, workingDir, displayCwd } = await resolveShellWorkingDirectory(req.user.profile.handle, workspace, character, cwd));
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        const message = error instanceof Error ? error.message : 'Failed to resolve the shell working directory.';
        if (statusCode >= 500) {
            console.error('Error resolving shell working directory:', error);
        }
        return res.status(statusCode).json({ error: message });
    }

    if (activeProcesses.shell) {
        console.log('Stopping previous shell process.');
        stopActiveShellProcess('replaced');
    }

    const runId = crypto.randomBytes(16).toString('hex');
    let clientDisconnected = false;
    let responseEnded = false;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders?.();

    const childProcess = spawn(POWERSHELL_COMMAND, buildPowerShellInvocationArgs(command), {
        cwd: workingDir,
        shell: false,
        env: {
            ...process.env,
            ST_SANDBOX_DIR: sandboxDir,
            ST_UPLOADS_DIR: sandboxDir,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
        },
    });

    const shellProcess = {
        runId,
        childProcess,
        cliXmlBuffer: '',
        stopRequested: false,
        stopReason: null,
    };
    activeProcesses.shell = shellProcess;

    writeShellEvent(res, {
        type: 'started',
        runId,
        explanation,
        command,
        cwd: displayCwd,
    });

    childProcess.stdout.on('data', (data) => {
        writeShellEvent(res, { type: 'stdout', runId, chunk: data.toString('utf-8') });
    });

    childProcess.stderr.on('data', (data) => {
        const filteredChunk = filterPowerShellStderrChunk(shellProcess, data.toString('utf-8'));
        if (!filteredChunk) {
            return;
        }

        writeShellEvent(res, { type: 'stderr', runId, chunk: filteredChunk });
    });

    childProcess.on('close', (code) => {
        console.log(`PowerShell process exited with code ${code}`);
        if (activeProcesses.shell?.runId === runId) {
            activeProcesses.shell = null;
        }

        if (clientDisconnected || responseEnded) {
            return;
        }

        responseEnded = true;
        if (shellProcess.stopRequested) {
            writeShellEvent(res, {
                type: 'stopped',
                runId,
                exitCode: code ?? null,
                reason: shellProcess.stopReason || 'stopped',
            });
        } else if (code === 0) {
            writeShellEvent(res, { type: 'completed', runId, exitCode: 0 });
        } else {
            writeShellEvent(res, {
                type: 'failed',
                runId,
                exitCode: code ?? null,
                message: `PowerShell exited with code ${code ?? 'unknown'}.`,
            });
        }
        res.end();
    });

    childProcess.on('error', (error) => {
        console.error('Failed to start PowerShell process.', error);
        if (activeProcesses.shell?.runId === runId) {
            activeProcesses.shell = null;
        }

        if (clientDisconnected || responseEnded) {
            return;
        }

        responseEnded = true;
        writeShellEvent(res, {
            type: 'failed',
            runId,
            message: `Failed to start PowerShell: ${error.message}`,
        });
        res.end();
    });

    const handleClientDisconnect = () => {
        if (responseEnded) {
            return;
        }

        clientDisconnected = true;
        if (activeProcesses.shell?.runId === runId) {
            activeProcesses.shell = null;
        }

        if (!childProcess.killed) {
            console.log('Client disconnected, killing PowerShell process.');
            childProcess.kill();
        }
    };

    req.on('aborted', handleClientDisconnect);
    res.on('close', handleClientDisconnect);
});

router.post('/executeshell/stop', (req, res) => {
    const { runId } = req.body ?? {};

    if (typeof runId !== 'string' || !runId.trim()) {
        return res.status(400).json({ error: 'runId is required.' });
    }

    if (!stopActiveShellProcess('stopped', runId)) {
        return res.status(404).json({ error: 'No running PowerShell command found for this run.' });
    }

    return res.json({ ok: true });
});

router.post('/executepython', async (req, res) => {
    const { code, timeout_ms, workspace, character } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'code is required.' });
    }

    let timeoutMs = DEFAULT_PYTHON_TIMEOUT_MS;
    if (timeout_ms !== undefined) {
        if (!Number.isFinite(Number(timeout_ms)) || Number(timeout_ms) <= 0) {
            return res.status(400).json({ error: 'timeout_ms must be a positive number.' });
        }

        timeoutMs = Math.min(MAX_PYTHON_TIMEOUT_MS, Math.floor(Number(timeout_ms)));
    }

    if (activeProcesses.python) {
        console.log('Stopping previous Python process.');
        stopActivePythonProcess('replaced');
    }

    const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);
    const tempFilename = `exec_${crypto.randomBytes(16).toString('hex')}.py`;
    const scriptPath = path.join(sandboxDir, tempFilename);
    await fs.mkdir(sandboxDir, { recursive: true });
    const launcher = resolvePythonLauncher();

    try {
        if (!launcher) {
            return res.status(500).json({ error: 'Python runtime not found. Install Python and ensure `python`, `python3`, or `py` is available on PATH.' });
        }

        await fs.writeFile(scriptPath, code, 'utf-8');

        const cleanupScript = async () => {
            try {
                await fs.unlink(scriptPath);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.error(`Failed to delete temp script: ${scriptPath}`, unlinkError);
                }
            }
        };

        const runId = crypto.randomBytes(16).toString('hex');
        let clientDisconnected = false;
        let responseEnded = false;

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders?.();

        const childProcess = spawn(launcher.command, [...launcher.args, '-u', scriptPath], {
            cwd: sandboxDir,
            shell: false,
            env: {
                ...process.env,
                ST_SANDBOX_DIR: sandboxDir,
                ST_UPLOADS_DIR: sandboxDir,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            },
        });

        const pythonProcess = {
            runId,
            childProcess,
            stopRequested: false,
            stopReason: null,
            timedOut: false,
        };
        activeProcesses.python = pythonProcess;

        const timeoutHandle = setTimeout(() => {
            if (activeProcesses.python?.runId !== runId) {
                return;
            }

            pythonProcess.timedOut = true;
            stopActivePythonProcess('timed_out', runId);
        }, timeoutMs);

        writeShellEvent(res, {
            type: 'started',
            runId,
            timeoutMs,
        });

        childProcess.stdout.on('data', (data) => {
            writeShellEvent(res, { type: 'stdout', runId, chunk: data.toString('utf-8') });
        });

        childProcess.stderr.on('data', (data) => {
            writeShellEvent(res, { type: 'stderr', runId, chunk: data.toString('utf-8') });
        });

        childProcess.on('close', async (code) => {
            clearTimeout(timeoutHandle);
            console.log(`Python process exited with code ${code}`);
            if (activeProcesses.python?.runId === runId) {
                activeProcesses.python = null;
            }

            await cleanupScript();

            if (clientDisconnected || responseEnded) {
                return;
            }

            responseEnded = true;
            if (pythonProcess.timedOut) {
                writeShellEvent(res, {
                    type: 'timed_out',
                    runId,
                    exitCode: code ?? null,
                    timeoutMs,
                });
            } else if (pythonProcess.stopRequested) {
                writeShellEvent(res, {
                    type: 'stopped',
                    runId,
                    exitCode: code ?? null,
                    reason: pythonProcess.stopReason || 'stopped',
                });
            } else if (code === 0) {
                writeShellEvent(res, { type: 'completed', runId, exitCode: 0 });
            } else {
                writeShellEvent(res, {
                    type: 'failed',
                    runId,
                    exitCode: code ?? null,
                    message: `Python exited with code ${code ?? 'unknown'}.`,
                });
            }
            res.end();
        });

        const handleClientDisconnect = async () => {
            if (responseEnded) {
                return;
            }

            clientDisconnected = true;
            clearTimeout(timeoutHandle);
            if (activeProcesses.python?.runId === runId) {
                activeProcesses.python = null;
            }

            if (!childProcess.killed) {
                console.log('Client disconnected, killing Python process.');
                childProcess.kill();
            }

            await cleanupScript();
        };

        req.on('aborted', handleClientDisconnect);
        res.on('close', handleClientDisconnect);

        childProcess.on('error', async (err) => {
            clearTimeout(timeoutHandle);
            console.error('Failed to start subprocess.', err);
            if (activeProcesses.python?.runId === runId) {
                activeProcesses.python = null;
            }

            await cleanupScript();

            if (clientDisconnected || responseEnded) {
                return;
            }

            responseEnded = true;
            if (!res.headersSent) {
                res.status(500).json({ error: `Failed to start subprocess: ${err.message}` });
            } else {
                writeShellEvent(res, {
                    type: 'failed',
                    runId,
                    message: `Failed to start Python: ${err.message}`,
                });
                res.end();
            }
        });
    } catch (error) {
        console.error('Error setting up Python execution:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `Server error: ${error.message}` });
        } else {
            res.end();
        }
    }
});

router.post('/executepython/stop', (req, res) => {
    const { runId } = req.body ?? {};

    if (typeof runId !== 'string' || !runId.trim()) {
        return res.status(400).json({ error: 'runId is required.' });
    }

    if (!stopActivePythonProcess('stopped', runId)) {
        return res.status(404).json({ error: 'No running Python command found for this run.' });
    }

    return res.json({ ok: true });
});

// ========== Stable Diffusion Image Generation Endpoints ==========

router.get('/sd_models', async (_req, res) => {
    try {
        const response = await fetch(`${SD_WEBUI_URL}/sdapi/v1/sd-models`);
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: `SD WebUI error: ${text}` });
        }
        const models = await response.json();
        return res.json(models);
    } catch (error) {
        console.error('Failed to fetch SD models:', error);
        return res.status(502).json({ error: `Could not connect to Stable Diffusion WebUI at ${SD_WEBUI_URL}. Is it running with --api?` });
    }
});

router.post('/sd_txt2img', async (req, res) => {
    try {
        const { 
            prompt, negative_prompt, model, width, height, 
            steps, cfg_scale, sampler_name, seed, 
            workspace, character, alwayson_scripts 
        } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'prompt is required' });
        }

        // If a model is specified, switch to it first
        if (model) {
            const optionsRes = await fetch(`${SD_WEBUI_URL}/sdapi/v1/options`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sd_model_checkpoint: model }),
            });
            if (!optionsRes.ok) {
                const text = await optionsRes.text();
                return res.status(optionsRes.status).json({ error: `Failed to switch model: ${text}` });
            }
        }

        const payload = {
            prompt,
            negative_prompt,
            width,
            height,
            steps,
            cfg_scale,
            sampler_name,
            seed,
        };

        if (alwayson_scripts) {
            payload.alwayson_scripts = alwayson_scripts;
        }

        // Generate the image
        const genResponse = await fetch(`${SD_WEBUI_URL}/sdapi/v1/txt2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!genResponse.ok) {
            const text = await genResponse.text();
            return res.status(genResponse.status).json({ error: `Image generation failed: ${text}` });
        }

        const genResult = await genResponse.json();

        if (!genResult.images || genResult.images.length === 0) {
            return res.status(500).json({ error: 'No images returned from SD WebUI' });
        }

        // Save the first image to the uploads directory
        const imageBuffer = Buffer.from(genResult.images[0], 'base64');
        const filename = `sd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
        const sandboxDir = getSandboxDir(req.user.profile.handle, workspace, character);
        const filepath = path.join(sandboxDir, filename);

        await fs.mkdir(sandboxDir, { recursive: true });
        await fs.writeFile(filepath, imageBuffer);

        return res.json({
            filepath: filename,
            info: genResult.info || 'Image generated successfully.',
        });
    } catch (error) {
        console.error('Failed to generate image via SD WebUI:', error);
        return res.status(502).json({ error: `Could not connect to Stable Diffusion WebUI at ${SD_WEBUI_URL}. Is it running with --api?` });
    }
});

/**
 * Wraps a browser endpoint and normalizes common error handling.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(userHandle: string) => Promise<any>} handler
 * @returns {Promise<void>}
 */
async function handleBrowserRequest(req, res, handler) {
    try {
        const result = await handler(req.user.profile.handle);
        res.json(result);
    } catch (error) {
        console.error('Browser tool request failed:', error);
        if (Array.isArray(error?.browserWarnings) && error.browserWarnings.length > 0) {
            return res.json({
                error: error instanceof Error ? error.message : 'Unknown browser error.',
                warnings: error.browserWarnings,
            });
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown browser error.' });
    }
}

/**
 * Opens a URL in a session tab and captures a screenshot of the result.
 * @param {string} userHandle
 * @param {any} body
 * @returns {Promise<any>}
 */
async function performBrowserOpen(userHandle, body) {
    const workspace = body.workspace;
    const character = body.character;
    const url = normalizeHttpUrl(body.url, 'url');
    const requestedSessionId = String(body.session_id ?? '').trim();
    const newTab = body.new_tab === true || body.new_tab === 'true';
    const directAsset = isDirectAssetUrl(url);
    const state = getBrowserState(userHandle);
    const existingSession = requestedSessionId
        ? (() => {
            const session = state.sessions.get(requestedSessionId);
            if (!session) {
                return null;
            }

            if (session.page.isClosed()) {
                state.sessions.delete(session.id);
                return null;
            }

            return session;
        })()
        : getMostRecentBrowserSession(userHandle);
    const session = existingSession ?? await createBrowserSession(userHandle, workspace, character);
    const reusedSession = Boolean(existingSession);

    touchBrowserSession(session, workspace, character);

    return await runBrowserSessionAction(session, async ({ workspace: sessionWorkspace, character: sessionCharacter }) => {
        let page = null;
        if (!reusedSession) {
            page = session.page;
        } else if (newTab) {
            const context = session.page.context();
            page = await context.newPage();
            trackSessionPage(session, page);
            session.page = page;
        } else {
            page = getSessionPage(session, body.tab_index);
            session.page = page;
        }

        await randomHumanDelay();
        await page.goto(url, { waitUntil: directAsset ? 'commit' : 'domcontentloaded' });
        if (!directAsset) {
            await waitForPageAfterInteraction(page, BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
        }
        const interstitial = await detectPageInterstitial(page);
        const screenshot = await saveBrowserScreenshot(userHandle, sessionWorkspace, sessionCharacter, page, body.screenshot_filepath, false);

        return await formatBrowserPageResult(session, page, {
            interstitial,
            screenshot_filepath: screenshot.filepath,
        });
    });
}

router.post('/browser/open', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => await performBrowserOpen(userHandle, req.body));
});

router.post('/browser/search', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => await performBrowserOpen(userHandle, {
        ...req.body,
        url: buildBrowserSearchUrl(req.body.query, req.body.engine),
    }));
});

router.post('/browser/close', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const sessionId = String(req.body.session_id ?? '').trim();
        if (!sessionId) {
            throw new Error('session_id is required.');
        }

        await destroyBrowserSession(userHandle, sessionId);
        return { session_id: sessionId, closed: true };
    });
});

router.post('/browser/tabs', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const action = String(req.body.action ?? 'list').trim().toLowerCase();
        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async () => {
            if (action === 'list') {
                return {
                    session_id: session.id,
                    active_tab_index: getSessionTabIndex(session, getSessionPage(session)),
                    tabs: await getSessionTabsSnapshot(session),
                };
            }

            if (action === 'select') {
                const page = getSessionPage(session, req.body.tab_index);
                session.page = page;
                await page.bringToFront().catch(() => undefined);
                const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);
                return {
                    ...(await formatBrowserPageResult(session, page, { screenshot_filepath: screenshot.filepath })),
                    active_tab_index: getSessionTabIndex(session, page),
                };
            }

            if (action === 'close') {
                const pages = getSessionPages(session);
                if (pages.length <= 1) {
                    throw new Error('Cannot close the last remaining tab with browser_tabs close. Use browser_close to close the whole session.');
                }

                const page = getSessionPage(session, req.body.tab_index);
                const closingIndex = getSessionTabIndex(session, page);
                await page.close({ runBeforeUnload: false });
                const activePage = getSessionPage(session);
                return {
                    session_id: session.id,
                    closed_tab_index: closingIndex,
                    active_tab_index: getSessionTabIndex(session, activePage),
                    tabs: await getSessionTabsSnapshot(session),
                };
            }

            throw new Error('browser/tabs action must be one of: list, select, close.');
        });
    });
});

router.post('/browser/back', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            await page.goBack({ waitUntil: 'domcontentloaded' });
            await waitForPageAfterInteraction(page, BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
            const interstitial = await detectPageInterstitial(page);
            const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);

            return await formatBrowserPageResult(session, page, {
                interstitial,
                screenshot_filepath: screenshot.filepath,
            });
        });
    });
});

router.post('/browser/click', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const selector = String(req.body.selector ?? '').trim();
        const text = String(req.body.text ?? '').trim();
        const button = ['left', 'middle', 'right'].includes(String(req.body.button ?? '').trim().toLowerCase())
            ? String(req.body.button).trim().toLowerCase()
            : 'left';
        const elementIndex = req.body.element_index;
        const textIndex = Number.isInteger(req.body.text_index)
            ? req.body.text_index
            : Number.isFinite(Number(req.body.text_index))
                ? Number(req.body.text_index)
                : null;
        const x = Number(req.body.x);
        const y = Number(req.body.y);
        const hasCoordinates = Number.isFinite(x) && Number.isFinite(y);
        const descriptorRequested = elementIndex !== null && typeof elementIndex !== 'undefined' && String(elementIndex).trim() !== '';
        const textRequested = Boolean(text);

        if (!selector && !textRequested && !hasCoordinates && !descriptorRequested) {
            throw new Error('Provide selector, text, element_index, or both x and y.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            const sourceUrl = page.url();
            /** @type {{x:number,y:number}|null} */
            let clickMarker = null;
            const actionFingerprint = getBrowserActionFingerprint('click', sourceUrl, {
                selector,
                text,
                textIndex,
                button,
                elementIndex: normalizeElementIndex(elementIndex),
                x,
                y,
            });
            const loop = detectBrowserActionLoop(session, actionFingerprint);
            if (loop.detected) {
                const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);
                return {
                    ...(await formatBrowserPageResult(session, page)),
                    current_url: sourceUrl,
                    url_changed: false,
                    loop_detected: true,
                    error: `Loop detected: same action performed ${loop.count} times`,
                    screenshot_filepath: screenshot.filepath,
                };
            }

            const popupPromise = page.waitForEvent('popup', { timeout: hasCoordinates ? 1_200 : 2_000 }).catch(() => null);
            let interactionMeta = { kind: hasCoordinates ? 'coordinates' : 'interactive' };
            /** @type {import('playwright').Locator|null} */
            let locator = null;

            if (hasCoordinates) {
                clickMarker = { x: Math.round(x), y: Math.round(y) };
            } else {
                ({ locator } = await resolveInteractionLocator(page, session, selector, elementIndex, text, textIndex));
                interactionMeta = await getLocatorInteractionMetadata(locator);
                clickMarker = await getLocatorClickPoint(locator);
            }

            if (hasCoordinates) {
                await page.mouse.move(x, y);
                await randomHumanDelay();
                await page.mouse.click(x, y, { button });
            } else {
                await randomHumanDelay();
                await clickLocatorReliably(locator, button);
            }

            await waitForPageAfterInteraction(page, hasCoordinates ? 1_500 : 2_500);
            const popup = await adoptPopupIfPresent(session, popupPromise, {
                sourceUrl,
                currentUrl: page.url(),
                expectedUrl: interactionMeta.href,
                interactionKind: interactionMeta.kind,
                clickedByCoordinates: hasCoordinates,
            });
            let urlChanged = page.url() !== sourceUrl;
            if (button === 'right' && !hasCoordinates && locator && !urlChanged && !popup) {
                await dispatchSyntheticContextMenu(locator, clickMarker).catch(() => undefined);
                await page.waitForTimeout(250).catch(() => undefined);
                urlChanged = page.url() !== sourceUrl;
            }
            const clickHadNoVisibleEffect = !urlChanged && !popup;
            const interstitial = await detectPageInterstitial(page);
            const postClickScreenshot = await saveBrowserScreenshot(
                userHandle,
                session.workspace,
                session.character,
                page,
                req.body.screenshot_filepath,
                false,
                clickHadNoVisibleEffect && clickMarker
                    ? {
                        clickMarker,
                        persistGridMs: 0,
                        persistClickMs: 0,
                    }
                    : {
                        persistGridMs: 0,
                        persistClickMs: 0,
                    },
            );
            if (clickHadNoVisibleEffect && clickMarker) {
                await addBrowserScreenshotOverlay(page, false, {
                    clickMarker,
                    persistGridMs: BROWSER_SCREENSHOT_GRID_PERSIST_MS,
                    persistClickMs: BROWSER_SCREENSHOT_CLICK_PERSIST_MS,
                }).catch(() => undefined);
            }
            const clickableElements = await getClickableElementsSnapshot(session, page).catch(() => []);
            const openedTabScreenshot = popup
                ? await saveBrowserScreenshot(userHandle, session.workspace, session.character, popup, req.body.opened_tab_screenshot_filepath, false)
                : null;
            recordBrowserAction(session, actionFingerprint);

            return await formatBrowserPageResult(session, page, {
                current_url: page.url(),
                url_changed: urlChanged,
                clickable_elements: clickableElements,
                interstitial,
                opened_tab_index: popup ? getSessionTabIndex(session, popup) : null,
                screenshot_filepath: postClickScreenshot.filepath,
                opened_tab_screenshot_filepath: openedTabScreenshot?.filepath ?? null,
            });
        });
    });
});

router.post('/browser/hover', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const selector = String(req.body.selector ?? '').trim();
        const text = String(req.body.text ?? '').trim();
        const elementIndex = req.body.element_index;
        const textIndex = Number.isInteger(req.body.text_index)
            ? req.body.text_index
            : Number.isFinite(Number(req.body.text_index))
                ? Number(req.body.text_index)
                : null;
        const x = Number(req.body.x);
        const y = Number(req.body.y);
        const hasCoordinates = Number.isFinite(x) && Number.isFinite(y);
        const descriptorRequested = elementIndex !== null && typeof elementIndex !== 'undefined' && String(elementIndex).trim() !== '';
        const textRequested = Boolean(text);

        if (!selector && !textRequested && !hasCoordinates && !descriptorRequested) {
            throw new Error('Provide selector, text, element_index, or both x and y.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            if (hasCoordinates) {
                await page.mouse.move(x, y);
            } else {
                const { locator } = await resolveInteractionLocator(page, session, selector, elementIndex, text, textIndex);
                await locator.scrollIntoViewIfNeeded().catch(() => undefined);
                await locator.hover();
            }

            const interstitial = await detectPageInterstitial(page);
            const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);
            return await formatBrowserPageResult(session, page, {
                interstitial,
                screenshot_filepath: screenshot.filepath,
            });
        });
    });
});

router.post('/browser/key', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const key = String(req.body.key ?? '').trim();
        const keys = Array.isArray(req.body.keys)
            ? req.body.keys.map(value => String(value ?? '').trim()).filter(Boolean)
            : [];
        const delayMs = Math.max(0, Math.min(Number(req.body.delay_ms) || 120, 2_000));
        const sequence = keys.length > 0 ? keys : (key ? [key] : []);

        if (sequence.length === 0) {
            throw new Error('Provide key or keys.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            await page.bringToFront().catch(() => undefined);

            for (const currentKey of sequence) {
                await page.keyboard.press(currentKey);
                if (delayMs > 0) {
                    await page.waitForTimeout(delayMs).catch(() => undefined);
                }
            }

            await waitForPageAfterInteraction(page, 1_000);
            const interstitial = await detectPageInterstitial(page);
            const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);

            return await formatBrowserPageResult(session, page, {
                interstitial,
                key: key || null,
                keys: sequence,
                screenshot_filepath: screenshot.filepath,
            });
        });
    });
});

router.post('/browser/type', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const selector = String(req.body.selector ?? '').trim();
        const elementIndex = req.body.element_index;
        const text = String(req.body.text ?? '');
        const submit = req.body.submit === true || req.body.submit === 'true';
        const descriptorRequested = elementIndex !== null && typeof elementIndex !== 'undefined' && String(elementIndex).trim() !== '';

        if (!text.length) {
            throw new Error('text is required.');
        }
        if (!selector && !descriptorRequested) {
            throw new Error('Provide selector or element_index.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            const { locator } = await resolveInteractionLocator(page, session, selector, elementIndex);
            await locator.scrollIntoViewIfNeeded().catch(() => undefined);
            await locator.click({ timeout: BROWSER_DEFAULT_WAIT_TIMEOUT_MS, force: true });
            await locator.fill('');
            await locator.type(text, { delay: 40 + Math.floor(Math.random() * 50) });
            if (submit) {
                await locator.press('Enter');
            }
            await page.waitForLoadState('networkidle', { timeout: BROWSER_DEFAULT_WAIT_TIMEOUT_MS }).catch(() => undefined);
            const interstitial = await detectPageInterstitial(page);
            const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);

            return await formatBrowserPageResult(session, page, {
                submitted: submit,
                interstitial,
                screenshot_filepath: screenshot.filepath,
            });
        });
    });
});

router.post('/browser/wait', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const text = String(req.body.text ?? '').trim();
        const selector = String(req.body.selector ?? '').trim();
        const timeout = Math.min(Math.max(Number(req.body.timeout_ms) || BROWSER_DEFAULT_WAIT_TIMEOUT_MS, 1), BROWSER_MAX_WAIT_TIMEOUT_MS);

        if (!text && !selector) {
            throw new Error('Either text or selector is required.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            if (selector) {
                const { locator } = await findFrameLocator(page, selector, timeout);
                await locator.waitFor({ timeout });
            } else {
                await waitForTextAcrossFrames(page, text, timeout);
            }

            const interstitial = await detectPageInterstitial(page);
            return await formatBrowserPageResult(session, page, {
                interstitial,
            });
        });
    });
});

router.post('/browser/domfetch', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            const result = await collectDomFetch(page, {
                mode: req.body.mode,
                selector: req.body.selector,
                max_chars: req.body.max_chars,
                limit: req.body.limit,
                offset: req.body.offset,
            });
            if (Array.isArray(result.descriptors)) {
                setSessionElementDescriptors(session, page, result.descriptors, result?.url || page.url());
            }
            const interstitial = await detectPageInterstitial(page);
            const publicResult = { ...result };
            delete publicResult.descriptors;
            return {
                ...(await formatBrowserPageResult(session, page)),
                interstitial,
                ...publicResult,
            };
        });
    });
});

router.post('/browser/executejs', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`execute_js timed out after ${EXECUTE_JS_TIMEOUT_MS} ms.`)), EXECUTE_JS_TIMEOUT_MS);
            });

            const execution = await Promise.race([
                executePageJavaScript(page, {
                    code: req.body.code,
                    selector: req.body.selector,
                    arg: req.body.arg,
                }),
                timeoutPromise,
            ]);

            const interstitial = await detectPageInterstitial(page);
            const screenshot = await saveBrowserScreenshot(userHandle, session.workspace, session.character, page, req.body.screenshot_filepath, false);
            return {
                ...(await formatBrowserPageResult(session, page)),
                result: execution?.value,
                changed_fields: Array.isArray(execution?.changed_fields) ? execution.changed_fields : [],
                interstitial,
                screenshot_filepath: screenshot.filepath,
            };
        });
    });
});

router.post('/browser/screenshot', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page, workspace, character }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();
            const output = await saveBrowserScreenshot(
                userHandle,
                workspace,
                character,
                page,
                req.body.filepath,
                req.body.full_page === true || req.body.full_page === 'true',
            );

            return {
                ...(await formatBrowserPageResult(session, page)),
                filepath: output.filepath,
                type: 'image_display',
            };
        });
    });
});

router.post('/browser/download', async (req, res) => {
    await handleBrowserRequest(req, res, async (userHandle) => {
        const session = getExistingBrowserSession(userHandle, req.body.session_id);
        const selector = String(req.body.selector ?? '').trim();
        const url = String(req.body.url ?? '').trim();

        if (!selector && !url) {
            throw new Error('Either selector or url is required.');
        }

        touchBrowserSession(session, req.body.workspace, req.body.character);

        return await runBrowserSessionAction(session, async ({ page, workspace, character }) => {
            page = getSessionPage(session, req.body.tab_index);
            session.page = page;
            await randomHumanDelay();

            if (selector) {
                const downloadPromise = page.waitForEvent('download', { timeout: BROWSER_DOWNLOAD_TIMEOUT_MS });
                const { locator } = await findFrameLocator(page, normalizeSelector(selector), BROWSER_DEFAULT_WAIT_TIMEOUT_MS);
                await locator.click();
                const download = await downloadPromise;
                const suggestedFilename = sanitizeFilename(download.suggestedFilename(), `download_${Date.now()}`);
                const fallbackFile = `downloads/${suggestedFilename}`;
                const output = await resolveSandboxWritePath(
                    userHandle,
                    workspace,
                    character,
                    req.body.filepath,
                    fallbackFile,
                );

                await download.saveAs(output.fullPath);
                const stats = await fs.stat(output.fullPath);
                const mimeType = guessMimeTypeFromFilepath(output.filepath);

                return {
                    ...(await formatBrowserPageResult(session, page)),
                    filepath: output.filepath,
                    filename: path.basename(output.filepath),
                    size: stats.size,
                    mime_type: mimeType,
                    is_image: isImageDownload(output.filepath, mimeType),
                };
            }

            const downloadUrl = normalizeHttpUrl(url, 'url');
            const cookies = await page.context().cookies(downloadUrl).catch(() => []);
            const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
            const output = await downloadHttpUrlToSandbox(
                userHandle,
                workspace,
                character,
                downloadUrl,
                req.body.filepath,
                page.url(),
                cookieHeader ? { Cookie: cookieHeader } : {},
            );

            return {
                ...(await formatBrowserPageResult(session, page)),
                ...output,
                is_image: isImageDownload(output.filepath, output.mime_type),
            };
        });
    });
});

addMcpToolRoutes(router);
