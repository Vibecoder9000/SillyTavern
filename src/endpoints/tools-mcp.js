import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getSandboxDir, ROOT_WORKSPACE_SENTINEL } from './sandbox.js';

const MCP_DEFAULT_TIMEOUT_MS = 30_000;
const MCP_MAX_TIMEOUT_MS = 180_000;
const MCP_STDERR_BUFFER_LIMIT = 16_000;
const MCP_REGISTRY_BASE_URL = process.env.MCP_OFFICIAL_REGISTRY_BASE_URL || 'https://registry.modelcontextprotocol.io';
const MCP_REGISTRY_LATEST_FLAG_KEY = 'io.modelcontextprotocol.registry/official';
const mcpSessions = new Map();
const mcpServerConfigs = new Map();
const mcpAuthStates = new Map();

function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        }),
    ]);
}

function normalizeTimeoutMs(rawTimeoutMs) {
    const parsed = Number.parseInt(String(rawTimeoutMs ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return MCP_DEFAULT_TIMEOUT_MS;
    }

    return Math.min(Math.max(parsed, 1_000), MCP_MAX_TIMEOUT_MS);
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function parseMultilineList(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item ?? '').trim()).filter(Boolean);
    }

    return String(value ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function parseKeyValueLines(value, separatorPattern) {
    const entries = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, entryValue] of Object.entries(value)) {
            const normalizedKey = String(key ?? '').trim();
            if (normalizedKey) {
                entries[normalizedKey] = String(entryValue ?? '').trim();
            }
        }
        return entries;
    }

    const lines = parseMultilineList(value);

    for (const line of lines) {
        const match = line.match(separatorPattern);
        if (!match) {
            continue;
        }

        const key = String(match[1] ?? '').trim();
        const entryValue = String(match[2] ?? '').trim();
        if (key) {
            entries[key] = entryValue;
        }
    }

    return entries;
}

function normalizeMcpServer(server) {
    const id = normalizeText(server?.id);
    const name = normalizeText(server?.name) || id || 'MCP Server';
    const rawTransportType = normalizeText(server?.transportType).toLowerCase();
    const transportType = rawTransportType === 'http' || rawTransportType === 'streamable-http'
        ? 'http'
        : rawTransportType === 'sse'
            ? 'sse'
            : 'stdio';
    const timeoutMs = normalizeTimeoutMs(server?.timeoutMs);
    const authType = normalizeText(server?.authType || server?.auth?.type).toLowerCase() === 'oauth' ? 'oauth' : 'none';
    const oauth = server?.oauth && typeof server.oauth === 'object' ? server.oauth : {};

    return {
        id,
        name,
        enabled: server?.enabled !== false,
        transportType,
        authType,
        timeoutMs,
        command: normalizeText(server?.command),
        args: parseMultilineList(server?.args ?? server?.argsText),
        cwd: normalizeText(server?.cwd),
        env: parseKeyValueLines(server?.env ?? server?.envText, /^([^=]+)=(.*)$/),
        url: normalizeText(server?.url),
        headers: parseKeyValueLines(server?.headers ?? server?.headersText, /^([^:]+):(.*)$/),
        unsafeStdioConfirmed: server?.unsafeStdioConfirmed === true,
        oauth: {
            redirectUrl: normalizeText(oauth.redirectUrl ?? server?.oauthRedirectUrl),
            clientId: normalizeText(oauth.clientId ?? server?.oauthClientId),
            clientSecret: normalizeText(oauth.clientSecret ?? server?.oauthClientSecret),
            scope: normalizeText(oauth.scope ?? server?.oauthScope),
        },
    };
}

function validateMcpServer(server) {
    if (!server.id) {
        throw new Error('MCP server id is required.');
    }

    if (server.transportType === 'http' || server.transportType === 'sse') {
        if (!server.url) {
            throw new Error('Remote MCP servers require a URL.');
        }

        try {
            new URL(server.url);
        } catch {
            throw new Error('Remote MCP server URL is invalid.');
        }

        if (server.authType === 'oauth' && !server.oauth.redirectUrl) {
            throw new Error('OAuth MCP servers require a redirect URL.');
        }

        return;
    }

    if (!server.command) {
        throw new Error('Stdio MCP servers require a command.');
    }

    if (server.unsafeStdioConfirmed !== true) {
        throw new Error('Stdio MCP servers must be explicitly approved before they can run local commands.');
    }
}

function getServerFingerprint(server) {
    return JSON.stringify({
        transportType: server.transportType,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        url: server.url,
        headers: server.headers,
        authType: server.authType,
        oauth: server.oauth,
        timeoutMs: server.timeoutMs,
    });
}

function getSessionKey(userHandle, serverId) {
    return `${userHandle}:${serverId}`;
}

function rememberServerConfig(userHandle, rawServer) {
    const server = normalizeMcpServer(rawServer);
    validateMcpServer(server);
    mcpServerConfigs.set(getSessionKey(userHandle, server.id), server);
    return server;
}

function resolveServerConfig(userHandle, requestBody = {}) {
    const serverId = normalizeText(requestBody.serverId ?? requestBody.server?.id);
    if (!serverId) {
        throw new Error('MCP server id is required.');
    }

    const server = mcpServerConfigs.get(getSessionKey(userHandle, serverId));
    if (!server) {
        throw new Error('MCP server must be connected before use.');
    }

    return server;
}

async function buildRootContext(userHandle, requestBody = {}) {
    const workspace = requestBody.workspace;
    const character = requestBody.character;
    const sandboxDir = getSandboxDir(userHandle, workspace, character);
    await fs.mkdir(sandboxDir, { recursive: true });

    const workspaceLabel = workspace === ROOT_WORKSPACE_SENTINEL
        ? 'uploads'
        : (normalizeText(workspace) || 'uploads');
    const characterLabel = normalizeText(character);
    const rootName = characterLabel
        ? `sandbox:${workspaceLabel}/${characterLabel}`
        : `sandbox:${workspaceLabel}`;

    return {
        workspace,
        character,
        sandboxDir,
        rootUri: pathToFileURL(path.resolve(sandboxDir)).href,
        rootName,
    };
}

function createRootsResult(rootContext) {
    return {
        roots: [{
            uri: rootContext.rootUri,
            name: rootContext.rootName,
        }],
    };
}

function summarizeStderr(stderrText) {
    const trimmed = normalizeText(stderrText);
    if (!trimmed) {
        return '';
    }

    return trimmed.length > MCP_STDERR_BUFFER_LIMIT
        ? trimmed.slice(-MCP_STDERR_BUFFER_LIMIT)
        : trimmed;
}

async function closeSession(session) {
    if (!session) {
        return;
    }

    try {
        if (typeof session.transport?.terminateSession === 'function') {
            await session.transport.terminateSession().catch(() => undefined);
        }
    } catch {
        // Best-effort cleanup.
    }

    try {
        if (typeof session.transport?.close === 'function') {
            await session.transport.close();
        }
    } catch {
        // Best-effort cleanup.
    }
}

function normalizeTool(tool) {
    return {
        name: normalizeText(tool?.name),
        title: normalizeText(tool?.title),
        description: normalizeText(tool?.description),
        inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        outputSchema: tool?.outputSchema && typeof tool.outputSchema === 'object' ? tool.outputSchema : null,
        annotations: tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {},
    };
}

function normalizeResource(resource) {
    const uri = normalizeText(resource?.uri ?? resource?.uriTemplate);
    return {
        uri,
        uriTemplate: normalizeText(resource?.uriTemplate),
        name: normalizeText(resource?.name),
        title: normalizeText(resource?.title),
        description: normalizeText(resource?.description),
        mimeType: normalizeText(resource?.mimeType),
        annotations: resource?.annotations && typeof resource.annotations === 'object' ? resource.annotations : {},
        size: Number.isFinite(resource?.size) ? resource.size : null,
    };
}

function normalizePrompt(prompt) {
    return {
        name: normalizeText(prompt?.name),
        title: normalizeText(prompt?.title),
        description: normalizeText(prompt?.description),
        arguments: Array.isArray(prompt?.arguments)
            ? prompt.arguments.map(argument => ({
                name: normalizeText(argument?.name),
                title: normalizeText(argument?.title),
                description: normalizeText(argument?.description),
                required: argument?.required === true,
            }))
            : [],
    };
}

function normalizeRegistryUrl(value) {
    const text = normalizeText(value);
    if (!text) {
        return '';
    }

    try {
        return new URL(text).toString();
    } catch {
        return '';
    }
}

function extractRegistryOfficialMeta(entry) {
    const meta = entry?._meta && typeof entry._meta === 'object' ? entry._meta : {};
    const official = meta[MCP_REGISTRY_LATEST_FLAG_KEY];
    return official && typeof official === 'object' ? official : {};
}

function normalizeRegistryHeader(header) {
    return {
        name: normalizeText(header?.name),
        description: normalizeText(header?.description),
        isRequired: header?.isRequired === true,
        isSecret: header?.isSecret === true,
    };
}

function normalizeRegistryRemote(remote) {
    return {
        type: normalizeText(remote?.type),
        url: normalizeRegistryUrl(remote?.url),
        headers: Array.isArray(remote?.headers) ? remote.headers.map(normalizeRegistryHeader).filter(header => header.name) : [],
    };
}

function normalizeRegistryPackage(pkg) {
    const transport = pkg?.transport && typeof pkg.transport === 'object' ? pkg.transport : {};
    return {
        registryType: normalizeText(pkg?.registryType),
        identifier: normalizeText(pkg?.identifier),
        version: normalizeText(pkg?.version),
        transportType: normalizeText(transport?.type),
    };
}

function normalizeRegistryEntry(record) {
    const server = record?.server && typeof record.server === 'object' ? record.server : {};
    const official = extractRegistryOfficialMeta(record);
    const repository = server.repository && typeof server.repository === 'object' ? server.repository : {};
    const publisherMeta = server._meta && typeof server._meta === 'object'
        ? server._meta['io.modelcontextprotocol.registry/publisher-provided']
        : null;
    const connectUrl = normalizeRegistryUrl(publisherMeta?.connect);
    const docsUrl = normalizeRegistryUrl(publisherMeta?.docs);

    return {
        name: normalizeText(server.name),
        title: normalizeText(server.title) || normalizeText(server.name),
        description: normalizeText(server.description),
        version: normalizeText(server.version),
        websiteUrl: normalizeRegistryUrl(server.websiteUrl),
        repositoryUrl: normalizeRegistryUrl(repository.url),
        status: normalizeText(official?.status) || 'active',
        updatedAt: normalizeText(official?.updatedAt),
        isLatest: official?.isLatest === true,
        remotes: Array.isArray(server.remotes) ? server.remotes.map(normalizeRegistryRemote).filter(remote => remote.url) : [],
        packages: Array.isArray(server.packages) ? server.packages.map(normalizeRegistryPackage).filter(pkg => pkg.identifier) : [],
        links: {
            connectUrl,
            docsUrl,
        },
    };
}

async function listRegistryEntries({ cursor = '', limit = 24, query = '' } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 24, 1), 100);
    const normalizedQuery = normalizeText(query).toLowerCase();
    const entries = [];
    let nextCursor = normalizeText(cursor);
    let exhausted = false;
    let pageCount = 0;
    let totalCount = null;

    while (entries.length < safeLimit && pageCount < 10 && !exhausted) {
        const url = new URL('/v0.1/servers', MCP_REGISTRY_BASE_URL);
        url.searchParams.set('limit', '100');
        url.searchParams.set('version', 'latest');
        if (nextCursor) {
            url.searchParams.set('cursor', nextCursor);
        }
        if (normalizedQuery) {
            url.searchParams.set('search', normalizedQuery);
        }

        const response = await withTimeout(
            fetch(url, {
                headers: {
                    Accept: 'application/json',
                },
            }),
            MCP_DEFAULT_TIMEOUT_MS,
            'Timed out while browsing the official MCP registry.',
        );

        if (!response.ok) {
            throw new Error(`Official MCP Registry request failed with status ${response.status}.`);
        }

        const payload = await response.json();
        if (Number.isFinite(payload?.metadata?.count)) {
            totalCount = payload.metadata.count;
        }
        const records = Array.isArray(payload?.servers) ? payload.servers : [];

        for (const record of records) {
            const entry = normalizeRegistryEntry(record);
            if (!entry.name || entry.status === 'deleted') {
                continue;
            }

            entries.push(entry);
            if (entries.length >= safeLimit) {
                break;
            }
        }

        nextCursor = normalizeText(payload?.metadata?.nextCursor);
        exhausted = !nextCursor;
        pageCount++;
    }

    return {
        entries,
        nextCursor,
        exhausted,
        totalCount,
    };
}

async function collectPaginated(session, methodName, resultKey, normalizeItem, requiredKey) {
    const items = [];
    let cursor;
    let pageCount = 0;

    do {
        const result = await withTimeout(
            session.client[methodName](cursor ? { cursor } : undefined),
            session.server.timeoutMs,
            `Timed out while listing ${resultKey} for "${session.server.name}".`,
        );

        if (Array.isArray(result?.[resultKey])) {
            items.push(...result[resultKey].map(normalizeItem).filter(item => item?.[requiredKey]));
        }

        cursor = normalizeText(result?.nextCursor);
        pageCount++;
    } while (cursor && pageCount < 100);

    return items;
}

async function collectPaginatedWithRetry(session, methodName, resultKey, normalizeItem, requiredKey) {
    const maxAttempts = session.server.transportType === 'stdio' ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const items = await collectPaginated(session, methodName, resultKey, normalizeItem, requiredKey);
            if (items.length > 0 || attempt === maxAttempts) {
                return items;
            }
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts) {
                throw error;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }

    if (lastError) {
        throw lastError;
    }

    return [];
}

async function safeListTools(session) {
    try {
        return await collectPaginatedWithRetry(session, 'listTools', 'tools', normalizeTool, 'name');
    } catch {
        return [];
    }
}

async function safeListResources(session) {
    try {
        return await collectPaginatedWithRetry(session, 'listResources', 'resources', normalizeResource, 'uri');
    } catch {
        return [];
    }
}

async function safeListResourceTemplates(session) {
    try {
        return await collectPaginatedWithRetry(session, 'listResourceTemplates', 'resourceTemplates', normalizeResource, 'uri');
    } catch {
        return [];
    }
}

async function safeListPrompts(session) {
    try {
        return await collectPaginatedWithRetry(session, 'listPrompts', 'prompts', normalizePrompt, 'name');
    } catch {
        return [];
    }
}

async function collectSnapshot(session) {
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        safeListTools(session),
        safeListResources(session),
        safeListResourceTemplates(session),
        safeListPrompts(session),
    ]);

    session.snapshot = {
        connected: true,
        serverInfo: session.client.getServerVersion() ?? null,
        capabilities: session.client.getServerCapabilities() ?? {},
        instructions: normalizeText(session.client.getInstructions()),
        tools,
        resources,
        resourceTemplates,
        prompts,
        stderr: summarizeStderr(session.stderrBuffer.join('')),
    };

    return session.snapshot;
}

function getAuthStateKey(userHandle, serverId) {
    return getSessionKey(userHandle, serverId);
}

function getAuthState(userHandle, server) {
    const key = getAuthStateKey(userHandle, server.id);
    if (!mcpAuthStates.has(key)) {
        mcpAuthStates.set(key, {});
    }

    return mcpAuthStates.get(key);
}

function createOAuthProvider(session) {
    if (session.server.authType !== 'oauth') {
        return undefined;
    }

    const state = getAuthState(session.userHandle, session.server);
    const clientInformation = session.server.oauth.clientId
        ? {
            client_id: session.server.oauth.clientId,
            ...(session.server.oauth.clientSecret ? { client_secret: session.server.oauth.clientSecret } : {}),
        }
        : state.clientInformation;

    return {
        redirectUrl: session.server.oauth.redirectUrl,
        clientMetadata: {
            client_name: 'SillyTavern',
            redirect_uris: [session.server.oauth.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: session.server.oauth.clientSecret ? 'client_secret_basic' : 'none',
            ...(session.server.oauth.scope ? { scope: session.server.oauth.scope } : {}),
        },
        clientInformation: () => clientInformation ?? state.clientInformation,
        saveClientInformation: (value) => {
            state.clientInformation = value;
        },
        tokens: () => state.tokens,
        saveTokens: (tokens) => {
            state.tokens = tokens;
            state.authorizationUrl = '';
        },
        redirectToAuthorization: (authorizationUrl) => {
            state.authorizationUrl = String(authorizationUrl);
        },
        saveCodeVerifier: (codeVerifier) => {
            state.codeVerifier = codeVerifier;
        },
        codeVerifier: () => state.codeVerifier,
        saveDiscoveryState: (discoveryState) => {
            state.discoveryState = discoveryState;
        },
        discoveryState: () => state.discoveryState,
        invalidateCredentials: (scope) => {
            if (scope === 'all' || scope === 'client') {
                delete state.clientInformation;
            }
            if (scope === 'all' || scope === 'tokens') {
                delete state.tokens;
            }
            if (scope === 'all' || scope === 'verifier') {
                delete state.codeVerifier;
            }
            if (scope === 'all' || scope === 'discovery') {
                delete state.discoveryState;
            }
        },
    };
}

function getRemoteRequestInit(server) {
    const headers = { ...server.headers };
    if (server.authType === 'oauth') {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'authorization') {
                delete headers[key];
            }
        }
    }

    return Object.keys(headers).length > 0 ? { headers } : undefined;
}

function getSseEventSourceInit(server, requestInit) {
    if (server.authType === 'oauth' || !requestInit?.headers || typeof fetch !== 'function') {
        return undefined;
    }

    return {
        fetch: (url, init) => fetch(url, {
            ...init,
            headers: {
                ...(init?.headers ?? {}),
                ...requestInit.headers,
            },
        }),
    };
}

function createTransport(session) {
    if (session.server.transportType === 'http') {
        return new StreamableHTTPClientTransport(new URL(session.server.url), {
            requestInit: getRemoteRequestInit(session.server),
            authProvider: createOAuthProvider(session),
        });
    }

    if (session.server.transportType === 'sse') {
        const requestInit = getRemoteRequestInit(session.server);
        return new SSEClientTransport(new URL(session.server.url), {
            requestInit,
            eventSourceInit: getSseEventSourceInit(session.server, requestInit),
            authProvider: createOAuthProvider(session),
        });
    }

    return new StdioClientTransport({
        command: session.server.command,
        args: session.server.args,
        cwd: session.server.cwd || undefined,
        env: Object.keys(session.server.env).length > 0
            ? { ...process.env, ...session.server.env }
            : undefined,
        stderr: 'pipe',
    });
}

async function createSession(userHandle, server, rootContext) {
    const session = {
        key: getSessionKey(userHandle, server.id),
        userHandle,
        server,
        fingerprint: getServerFingerprint(server),
        rootContext,
        client: null,
        transport: null,
        snapshot: null,
        stderrBuffer: [],
        lastListChangedAt: 0,
    };

    const client = new Client({
        name: 'SillyTavern',
        version: '1.0.0',
    }, {
        capabilities: {
            roots: {
                listChanged: true,
            },
        },
        listChanged: {
            tools: {
                onChanged: (error) => handleMcpListChanged(session, error),
            },
            resources: {
                onChanged: (error) => handleMcpListChanged(session, error),
            },
            prompts: {
                onChanged: (error) => handleMcpListChanged(session, error),
            },
        },
    });

    client.setRequestHandler(ListRootsRequestSchema, async () => createRootsResult(session.rootContext));
    const transport = createTransport(session);

    if (typeof transport.stderr?.on === 'function') {
        transport.stderr.on('data', chunk => {
            session.stderrBuffer.push(String(chunk ?? ''));
            const stderrText = session.stderrBuffer.join('');
            if (stderrText.length > MCP_STDERR_BUFFER_LIMIT) {
                session.stderrBuffer = [stderrText.slice(-MCP_STDERR_BUFFER_LIMIT)];
            }
        });
    }

    transport.onerror = (error) => {
        session.lastError = error instanceof Error ? error.message : String(error);
    };

    transport.onclose = () => {
        if (mcpSessions.get(session.key) === session) {
            mcpSessions.delete(session.key);
        }
    };

    session.client = client;
    session.transport = transport;

    try {
        await withTimeout(
            client.connect(transport),
            server.timeoutMs,
            `Timed out while connecting to "${server.name}".`,
        );
    } catch (error) {
        const authState = getAuthState(userHandle, server);
        if (authState?.authorizationUrl) {
            error.authState = authState;
        }
        await closeSession(session);
        throw error;
    }

    await collectSnapshot(session);
    mcpSessions.set(session.key, session);
    return session;
}

function handleMcpListChanged(session, error) {
    if (error) {
        session.lastError = error instanceof Error ? error.message : String(error);
        return;
    }

    const now = Date.now();
    if (now - session.lastListChangedAt < 500) {
        return;
    }
    session.lastListChangedAt = now;

    void collectSnapshot(session).catch(snapshotError => {
        session.lastError = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
    });
}

async function updateSessionRootContext(session, rootContext) {
    const rootChanged = session.rootContext?.rootUri !== rootContext.rootUri || session.rootContext?.rootName !== rootContext.rootName;
    session.rootContext = rootContext;

    if (rootChanged && typeof session.client?.sendRootsListChanged === 'function') {
        await session.client.sendRootsListChanged().catch(() => undefined);
    }
}

async function ensureSession(userHandle, rawServer, requestBody, { forceReconnect = false, refreshSnapshot = false } = {}) {
    const server = normalizeMcpServer(rawServer);
    validateMcpServer(server);

    const key = getSessionKey(userHandle, server.id);
    const rootContext = await buildRootContext(userHandle, requestBody);
    const fingerprint = getServerFingerprint(server);
    const existingSession = mcpSessions.get(key);

    if (existingSession && !forceReconnect && existingSession.fingerprint === fingerprint) {
        existingSession.server = server;
        await updateSessionRootContext(existingSession, rootContext);
        if (refreshSnapshot || !existingSession.snapshot) {
            await collectSnapshot(existingSession);
        }
        return existingSession;
    }

    if (existingSession) {
        mcpSessions.delete(key);
        await closeSession(existingSession);
    }

    return await createSession(userHandle, server, rootContext);
}

async function callMcpTool(session, toolName, args, timeoutMs) {
    return await withTimeout(
        // Use the base request path instead of client.callTool().
        // The current SDK enforces structuredContent when a tool advertises outputSchema,
        // but many real servers still return valid content-only results.
        // The protocol schema allows content-only CallToolResult payloads, so accept them here.
        session.client.request({
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: args,
            },
        }, CallToolResultSchema),
        timeoutMs,
        `Timed out while running "${toolName}" on "${session.server.name}".`,
    );
}

function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error ?? 'Unknown error');
}

function normalizeOAuthAuthorizationCode(rawCode) {
    const text = normalizeText(rawCode);
    try {
        const url = new URL(text);
        return normalizeText(url.searchParams.get('code')) || text;
    } catch {
        return text;
    }
}

function getSessionSummary(session) {
    return {
        server: {
            id: session.server.id,
            name: session.server.name,
            transportType: session.server.transportType,
            enabled: session.server.enabled,
        },
        snapshot: session.snapshot ?? {
            connected: true,
            tools: [],
            resources: [],
            resourceTemplates: [],
            prompts: [],
        },
    };
}

function getAuthErrorDetails(error) {
    const authState = error?.authState;
    if (error instanceof UnauthorizedError || authState?.authorizationUrl) {
        return {
            requiresAuth: true,
            authUrl: normalizeText(authState?.authorizationUrl),
        };
    }

    return null;
}

async function withSessionResponse(req, res, handler) {
    try {
        const userHandle = req.user.profile.handle;
        const result = await handler(userHandle);
        return res.json(result);
    } catch (error) {
        console.error('[MCP] Request failed:', error);
        const authDetails = getAuthErrorDetails(error);
        return res.status(authDetails ? 401 : 500).json({
            error: formatError(error),
            ...(authDetails ?? {}),
        });
    }
}

export function addMcpToolRoutes(router) {
    router.post('/mcp/registry/list', async (req, res) => {
        await withSessionResponse(req, res, async () => {
            return await listRegistryEntries({
                cursor: req.body?.cursor,
                limit: req.body?.limit,
                query: req.body?.query,
            });
        });
    });

    router.post('/mcp/connect', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = rememberServerConfig(userHandle, req.body?.server);
            const session = await ensureSession(userHandle, server, req.body, {
                forceReconnect: true,
                refreshSnapshot: true,
            });
            return getSessionSummary(session);
        });
    });

    router.post('/mcp/disconnect', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const serverId = normalizeText(req.body?.serverId ?? req.body?.server?.id);
            if (!serverId) {
                throw new Error('MCP server id is required.');
            }

            const key = getSessionKey(userHandle, serverId);
            const server = mcpServerConfigs.get(key) ?? {
                id: serverId,
                name: normalizeText(req.body?.server?.name) || serverId,
            };
            const session = mcpSessions.get(key);
            if (session) {
                mcpSessions.delete(key);
                await closeSession(session);
            }
            mcpServerConfigs.delete(key);

            return {
                ok: true,
                server: {
                    id: server.id,
                    name: server.name,
                },
            };
        });
    });

    router.post('/mcp/refresh', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = rememberServerConfig(userHandle, req.body?.server);
            const session = await ensureSession(userHandle, server, req.body, {
                refreshSnapshot: true,
            });
            return getSessionSummary(session);
        });
    });

    router.post('/mcp/auth/finish', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const code = normalizeOAuthAuthorizationCode(req.body?.code);
            if (!code) {
                throw new Error('OAuth authorization code is required.');
            }

            const server = req.body?.server
                ? rememberServerConfig(userHandle, req.body.server)
                : resolveServerConfig(userHandle, req.body);
            if (server.authType !== 'oauth' || (server.transportType !== 'http' && server.transportType !== 'sse')) {
                throw new Error('This MCP server is not configured for remote OAuth.');
            }

            const session = {
                userHandle,
                server,
            };
            const provider = createOAuthProvider(session);
            await withTimeout(
                auth(provider, {
                    serverUrl: server.url,
                    authorizationCode: code,
                    scope: server.oauth.scope || undefined,
                }),
                server.timeoutMs,
                `Timed out while authorizing "${server.name}".`,
            );

            const connectedSession = await ensureSession(userHandle, server, req.body, {
                forceReconnect: true,
                refreshSnapshot: true,
            });
            return getSessionSummary(connectedSession);
        });
    });

    router.post('/mcp/tools/call', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = resolveServerConfig(userHandle, req.body);
            const session = await ensureSession(userHandle, server, req.body);
            const result = await callMcpTool(
                session,
                normalizeText(req.body?.toolName),
                req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {},
                session.server.timeoutMs,
            );

            return {
                server: {
                    id: session.server.id,
                    name: session.server.name,
                },
                result,
            };
        });
    });

    router.post('/mcp/resources/list', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = resolveServerConfig(userHandle, req.body);
            const session = await ensureSession(userHandle, server, req.body);
            return {
                server: {
                    id: session.server.id,
                    name: session.server.name,
                },
                resources: await safeListResources(session),
                resourceTemplates: await safeListResourceTemplates(session),
            };
        });
    });

    router.post('/mcp/resources/read', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = resolveServerConfig(userHandle, req.body);
            const session = await ensureSession(userHandle, server, req.body);
            const result = await withTimeout(
                session.client.readResource({
                    uri: normalizeText(req.body?.uri),
                }),
                session.server.timeoutMs,
                `Timed out while reading "${req.body?.uri}" from "${session.server.name}".`,
            );

            return {
                server: {
                    id: session.server.id,
                    name: session.server.name,
                },
                result,
            };
        });
    });

    router.post('/mcp/prompts/list', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = resolveServerConfig(userHandle, req.body);
            const session = await ensureSession(userHandle, server, req.body);
            return {
                server: {
                    id: session.server.id,
                    name: session.server.name,
                },
                prompts: await safeListPrompts(session),
            };
        });
    });

    router.post('/mcp/prompts/get', async (req, res) => {
        await withSessionResponse(req, res, async (userHandle) => {
            const server = resolveServerConfig(userHandle, req.body);
            const session = await ensureSession(userHandle, server, req.body);
            const result = await withTimeout(
                session.client.getPrompt({
                    name: normalizeText(req.body?.name),
                    arguments: req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {},
                }),
                session.server.timeoutMs,
                `Timed out while getting prompt "${req.body?.name}" from "${session.server.name}".`,
            );

            return {
                server: {
                    id: session.server.id,
                    name: session.server.name,
                },
                result,
            };
        });
    });
}
