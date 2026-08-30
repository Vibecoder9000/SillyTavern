import crypto from 'node:crypto';
import http from 'node:http';

import fetch from 'node-fetch';

import { readSecret, SecretManager } from '../../secrets.js';
import {
    CODEX_BROWSER_CALLBACK_PORT,
    CODEX_BROWSER_REDIRECT_URI,
    CODEX_CLIENT_ID,
    CODEX_DEVICE_VERIFICATION_URL,
    CODEX_ISSUER,
    CODEX_OAUTH_SECRET_KEY,
} from './constants.js';
import { clearObservedLimits, readObservedLimits } from './limits.js';

const browserFlows = new Map();
const deviceFlows = new Map();
const refreshPromises = new Map();
let callbackServer = null;

function base64Url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

function randomId(bytes = 24) {
    return base64Url(crypto.randomBytes(bytes));
}

function createPkce() {
    const verifier = randomId(48);
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function parseJwt(token) {
    try {
        const payload = String(token || '').split('.')[1];
        return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : null;
    } catch {
        return null;
    }
}

function getAuthClaims(tokens) {
    const idClaims = parseJwt(tokens.id_token);
    const accessClaims = parseJwt(tokens.access_token);
    return idClaims || accessClaims || {};
}

function getAccountId(tokens) {
    for (const claims of [parseJwt(tokens.id_token), parseJwt(tokens.access_token)]) {
        const id = claims?.chatgpt_account_id
            || claims?.['https://api.openai.com/auth']?.chatgpt_account_id
            || claims?.organizations?.[0]?.id;
        if (id) return id;
    }
    return null;
}

function accountFromTokens(tokens, previous = {}) {
    const claims = getAuthClaims(tokens);
    const authClaims = claims?.['https://api.openai.com/auth'] || {};
    const accountId = getAccountId(tokens) || previous.accountId;
    if (!accountId) throw new Error('ChatGPT did not return an account identifier');
    const organization = Array.isArray(claims.organizations)
        ? claims.organizations.find(item => item?.id === accountId) || claims.organizations[0]
        : null;
    return {
        ...previous,
        accountId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || previous.refreshToken,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        email: claims.email || previous.email || null,
        planType: authClaims.chatgpt_plan_type || claims.chatgpt_plan_type || previous.planType || null,
        workspaceName: organization?.title || organization?.name || previous.workspaceName || null,
        residency: authClaims.chatgpt_compute_residency === 'no_constraint'
            ? null
            : authClaims.chatgpt_compute_residency || claims.chatgpt_compute_residency || previous.residency || null,
        reconnectRequired: false,
        lastError: null,
    };
}

function emptyVault() {
    return { version: 1, activeAccountId: null, accounts: {} };
}

export function readVault(directories) {
    const raw = readSecret(directories, CODEX_OAUTH_SECRET_KEY);
    if (!raw) return emptyVault();
    try {
        const vault = JSON.parse(raw);
        if (!vault || typeof vault !== 'object' || typeof vault.accounts !== 'object') return emptyVault();
        return { version: 1, activeAccountId: vault.activeAccountId || null, accounts: vault.accounts || {} };
    } catch {
        return emptyVault();
    }
}

function writeVault(directories, vault) {
    const manager = new SecretManager(directories);
    if (Object.keys(vault.accounts).length > 0) {
        manager.replaceSecret(CODEX_OAUTH_SECRET_KEY, JSON.stringify(vault), 'ChatGPT Codex accounts');
    } else {
        manager.deleteSecrets(CODEX_OAUTH_SECRET_KEY);
    }
}

function saveAccount(directories, tokens) {
    const vault = readVault(directories);
    const accountId = getAccountId(tokens);
    const previous = accountId ? vault.accounts[accountId] : undefined;
    const account = accountFromTokens(tokens, previous);
    vault.accounts[account.accountId] = account;
    vault.activeAccountId = account.accountId;
    writeVault(directories, vault);
    return account;
}

function publicAccount(account, active, userHandle) {
    return {
        accountId: account.accountId,
        email: account.email,
        planType: account.planType,
        workspaceName: account.workspaceName,
        expiresAt: account.expiresAt,
        reconnectRequired: Boolean(account.reconnectRequired),
        lastError: account.lastError || null,
        active,
        limits: readObservedLimits(userHandle, account.accountId),
    };
}

export function getAuthStatus(request) {
    const vault = readVault(request.user.directories);
    const userHandle = request.user.profile.handle;
    const accounts = Object.values(vault.accounts).map(account => publicAccount(account, account.accountId === vault.activeAccountId, userHandle));
    const activeAccount = accounts.find(account => account.active) || null;
    return {
        connected: Boolean(activeAccount && !activeAccount.reconnectRequired),
        browserAvailable: isLocalBrowserRequest(request),
        activeAccountId: activeAccount?.accountId || null,
        accounts,
    };
}

function isLoopbackAddress(address) {
    const value = String(address || '').toLowerCase();
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isLocalBrowserRequest(request) {
    const hostname = String(request.hostname || '').toLowerCase();
    const localHostname = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    return localHostname && isLoopbackAddress(request.ip || request.socket?.remoteAddress);
}

async function exchangeCode(code, redirectUri, verifier) {
    const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CODEX_CLIENT_ID,
            code_verifier: verifier,
        }).toString(),
    });
    if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
    return response.json();
}

async function refreshTokens(refreshToken) {
    const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CODEX_CLIENT_ID,
        }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error_description || `Token refresh failed (${response.status})`);
        error.code = data.error;
        throw error;
    }
    return data;
}

function markReconnectRequired(directories, accountId, error) {
    const vault = readVault(directories);
    const account = vault.accounts[accountId];
    if (!account) return;
    account.accessToken = null;
    account.refreshToken = null;
    account.expiresAt = 0;
    account.reconnectRequired = true;
    account.lastError = error.message || String(error);
    writeVault(directories, vault);
}

export function requireReconnect(request, accountId, message) {
    markReconnectRequired(request.user.directories, accountId, new Error(message));
}

export async function getAccessAccount(request, { forceRefresh = false } = {}) {
    const directories = request.user.directories;
    const userHandle = request.user.profile.handle;
    let vault = readVault(directories);
    let account = vault.accounts[vault.activeAccountId];
    if (!account) throw new Error('Sign in to ChatGPT before using the Codex provider');
    if (account.reconnectRequired && !forceRefresh) throw new Error('ChatGPT account needs to be reconnected');
    if (!forceRefresh && account.accessToken && account.expiresAt > Date.now() + 60_000) return account;

    const key = `${userHandle}:${account.accountId}`;
    if (!refreshPromises.has(key)) {
        refreshPromises.set(key, (async () => {
            try {
                const tokens = await refreshTokens(account.refreshToken);
                vault = readVault(directories);
                const savedAccount = vault.accounts[account.accountId];
                if (!savedAccount) throw new Error('ChatGPT account was signed out while its token was refreshing');
                account = accountFromTokens(tokens, savedAccount);
                vault.accounts[account.accountId] = account;
                writeVault(directories, vault);
                return account;
            } catch (error) {
                if (error.code === 'invalid_grant') markReconnectRequired(directories, account.accountId, error);
                throw error;
            } finally {
                refreshPromises.delete(key);
            }
        })());
    }
    return refreshPromises.get(key);
}

function buildAuthorizeUrl(challenge, state) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CODEX_CLIENT_ID,
        redirect_uri: CODEX_BROWSER_REDIRECT_URI,
        scope: 'openid profile email offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: 'sillytavern',
    });
    return `${CODEX_ISSUER}/oauth/authorize?${params}`;
}

function callbackPage(success, message) {
    const title = success ? 'ChatGPT connected' : 'ChatGPT sign-in failed';
    const escapedMessage = String(message).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;background:#181818;color:#eee;display:grid;place-items:center;min-height:90vh}main{max-width:36rem;text-align:center}</style><main><h1>${title}</h1><p>${escapedMessage}</p><p>You can close this window.</p></main>`;
}

async function handleBrowserCallback(request, response) {
    const url = new URL(request.url, CODEX_BROWSER_REDIRECT_URI);
    if (url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }
    const state = url.searchParams.get('state');
    const flow = browserFlows.get(state);
    if (!flow || flow.expiresAt < Date.now()) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, 'The authorization request is missing or expired.'));
        return;
    }
    if (url.searchParams.get('error')) {
        flow.status = 'failed';
        flow.error = url.searchParams.get('error_description') || url.searchParams.get('error');
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, flow.error));
        return;
    }
    try {
        const code = url.searchParams.get('code');
        if (!code) throw new Error('No authorization code was returned');
        const tokens = await exchangeCode(code, CODEX_BROWSER_REDIRECT_URI, flow.verifier);
        const account = saveAccount(flow.directories, tokens);
        flow.status = 'complete';
        flow.accountId = account.accountId;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(true, 'SillyTavern can now use your Codex subscription.'));
    } catch (error) {
        flow.status = 'failed';
        flow.error = error.message;
        response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(callbackPage(false, error.message));
    }
}

async function ensureCallbackServer() {
    if (callbackServer) return;
    callbackServer = http.createServer((request, response) => void handleBrowserCallback(request, response));
    await new Promise((resolve, reject) => {
        callbackServer.once('error', reject);
        callbackServer.listen(CODEX_BROWSER_CALLBACK_PORT, '127.0.0.1', resolve);
    }).catch(error => {
        callbackServer = null;
        throw error;
    });
}

function cleanupFlows() {
    const now = Date.now();
    for (const [key, flow] of browserFlows) if (flow.expiresAt < now) browserFlows.delete(key);
    for (const [key, flow] of deviceFlows) if (flow.expiresAt < now) deviceFlows.delete(key);
    if (callbackServer && browserFlows.size === 0) {
        callbackServer.close();
        callbackServer = null;
    }
}

export async function startBrowserFlow(request) {
    cleanupFlows();
    if (!isLocalBrowserRequest(request)) {
        const error = new Error('Browser sign-in is only available when SillyTavern is accessed locally');
        error.status = 400;
        throw error;
    }
    try {
        await ensureCallbackServer();
    } catch {
        const error = new Error('Could not open the local OAuth callback on port 1455.');
        error.status = 409;
        throw error;
    }
    const { verifier, challenge } = createPkce();
    const state = randomId();
    const flowId = randomId();
    browserFlows.set(state, {
        flowId,
        state,
        verifier,
        status: 'pending',
        expiresAt: Date.now() + 10 * 60_000,
        userHandle: request.user.profile.handle,
        directories: request.user.directories,
    });
    setTimeout(cleanupFlows, 10 * 60_000 + 1000).unref?.();
    return { flowId, authorizationUrl: buildAuthorizeUrl(challenge, state), expiresAt: Date.now() + 10 * 60_000 };
}

export function pollBrowserFlow(request, flowId) {
    cleanupFlows();
    const flow = [...browserFlows.values()].find(item => item.flowId === flowId && item.userHandle === request.user.profile.handle);
    if (!flow) return { status: 'expired' };
    const result = { status: flow.status, error: flow.error || null, accountId: flow.accountId || null };
    if (flow.status !== 'pending') browserFlows.delete(flow.state);
    cleanupFlows();
    return result;
}

export async function startDeviceFlow(request) {
    cleanupFlows();
    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SillyTavern' },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    if (!response.ok) throw new Error(`Could not start device authorization (${response.status})`);
    const data = await response.json();
    const flowId = randomId();
    const interval = Math.max(Number.parseInt(data.interval) || 5, 1);
    deviceFlows.set(flowId, {
        flowId,
        deviceAuthId: data.device_auth_id,
        userCode: data.user_code,
        interval,
        nextPollAt: 0,
        expiresAt: Date.now() + 15 * 60_000,
        userHandle: request.user.profile.handle,
    });
    setTimeout(cleanupFlows, 15 * 60_000 + 1000).unref?.();
    return { flowId, userCode: data.user_code, verificationUrl: CODEX_DEVICE_VERIFICATION_URL, interval, expiresAt: Date.now() + 15 * 60_000 };
}

export async function pollDeviceFlow(request, flowId) {
    cleanupFlows();
    const flow = deviceFlows.get(flowId);
    if (!flow || flow.userHandle !== request.user.profile.handle) return { status: 'expired' };
    if (Date.now() < flow.nextPollAt) return { status: 'pending', retryAfter: Math.ceil((flow.nextPollAt - Date.now()) / 1000) };
    flow.nextPollAt = Date.now() + flow.interval * 1000;
    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SillyTavern' },
        body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
    });
    if (response.status === 403 || response.status === 404) return { status: 'pending' };
    if (!response.ok) {
        deviceFlows.delete(flowId);
        return { status: 'failed', error: `Device authorization failed (${response.status})` };
    }
    try {
        const data = await response.json();
        const tokens = await exchangeCode(data.authorization_code, `${CODEX_ISSUER}/deviceauth/callback`, data.code_verifier);
        const account = saveAccount(request.user.directories, tokens);
        deviceFlows.delete(flowId);
        return { status: 'complete', accountId: account.accountId };
    } catch (error) {
        deviceFlows.delete(flowId);
        return { status: 'failed', error: error.message };
    }
}

export function cancelFlow(request, flowId) {
    const browser = [...browserFlows.entries()].find(([, flow]) => flow.flowId === flowId && flow.userHandle === request.user.profile.handle);
    if (browser) browserFlows.delete(browser[0]);
    const device = deviceFlows.get(flowId);
    if (device?.userHandle === request.user.profile.handle) deviceFlows.delete(flowId);
    cleanupFlows();
}

export function activateAccount(request, accountId) {
    const vault = readVault(request.user.directories);
    if (!vault.accounts[accountId]) return false;
    vault.activeAccountId = accountId;
    writeVault(request.user.directories, vault);
    return true;
}

export function signOutAccount(request, accountId) {
    const vault = readVault(request.user.directories);
    const target = accountId || vault.activeAccountId;
    if (!target || !vault.accounts[target]) return false;
    delete vault.accounts[target];
    clearObservedLimits(request.user.profile.handle, target);
    if (vault.activeAccountId === target) vault.activeAccountId = Object.keys(vault.accounts)[0] || null;
    writeVault(request.user.directories, vault);
    return true;
}
