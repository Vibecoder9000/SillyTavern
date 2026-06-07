import { DOMPurify } from '../lib.js';
import { power_user } from './power-user.js';
import { accountStorage } from './util/AccountStorage.js';

import {
    addOneMessage,
    chat,
    chat_metadata,
    event_types,
    eventSource,
    getCurrentSandboxCharacterName,
    getCurrentSandboxWorkspace,
    getDefaultSandboxWorkspace,
    main_api,
    getRequestHeaders,
    saveChatConditional,
    saveSettingsDebounced,
    SANDBOX_ROOT_WORKSPACE,
    system_avatar,
    systemUserName,
    updateMessageBlock,
    user_avatar,
} from '../script.js';
import { chat_completion_sources, custom_prompt_post_processing_types, getChatCompletionModel, model_list, oai_settings } from './openai.js';
import { POPUP_TYPE, Popup } from './popup.js';
import { autoFitSendTextAreaDebounced } from './RossAscends-mods.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandClosure } from './slash-commands/SlashCommandClosure.js';
import { enumIcons } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { enumTypes, SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { slashCommandReturnHelper } from './slash-commands/SlashCommandReturnHelper.js';
import { getSanitizedFilename, isTrueBoolean } from './utils.js';
import { setPersonaDescription } from './personas.js';

/**
 * @typedef {object} ToolInvocation
 * @property {string} id - A unique identifier for the tool invocation.
 * @property {string} displayName - The display name of the tool.
 * @property {string} name - The name of the tool.
 * @property {string} parameters - The parameters for the tool invocation.
 * @property {string} result - The result of the tool invocation.
 * @property {string?} signature - The thought signature associated with the tool invocation.
 * @property {string?} reasoning - The plaintext reasoning associated with this tool call turn.
 * @property {boolean} [error] - Whether the tool invocation failed.
 */

/**
 * @typedef {object} ToolInvocationResult
 * @property {ToolInvocation[]} invocations Tool invocations (both successful and failed)
 * @property {Error[]} errors Errors that occurred during tool invocation
 * @property {string[]} stealthCalls Names of stealth tools that were invoked
 */

/**
 * @typedef {object} ToolRegistration
 * @property {string} name - The name of the tool.
 * @property {string} displayName - The display name of the tool.
 * @property {string} description - A description of the tool.
 * @property {object} parameters - The parameters for the tool.
 * @property {function} action - The action to perform when the tool is invoked.
 * @property {function} [formatMessage] - A function to format the tool call message.
 * @property {function} [shouldRegister] - A function to determine if the tool should be registered.
 * @property {boolean} [stealth] - A tool call result will not be shown in the chat. No follow-up generation will be performed.
 * @property {object} [displayMetadata] - Optional display-only metadata for rendering tool calls.
 */

/**
 * @typedef {object} ToolDefinitionOpenAI
 * @property {string} type - The type of the tool.
 * @property {object} function - The function definition.
 * @property {string} function.name - The name of the function.
 * @property {string} function.description - The description of the function.
 * @property {object} function.parameters - The parameters of the function.
 * @property {function} toString - A function to convert the tool to a string.
 */

/**
 * Assigns nested variables to a scope.
 * @param {import('./slash-commands/SlashCommandScope.js').SlashCommandScope} scope The scope to assign variables to.
 * @param {object} arg Object to assign variables from.
 * @param {string} prefix Prefix for the variable names.
 */
function assignNestedVariables(scope, arg, prefix) {
    Object.entries(arg).forEach(([key, value]) => {
        const newPrefix = `${prefix}.${key}`;
        if (typeof value === 'object' && value !== null) {
            if (Array.isArray(value)) {
                scope.letVariable(newPrefix, JSON.stringify(value));
            }
            assignNestedVariables(scope, value, newPrefix);
        } else {
            scope.letVariable(newPrefix, value);
        }
    });
}

/**
 * Checks if a string is a valid JSON string.
 * @param {string} str The string to check
 * @returns {boolean} If the string is a valid JSON string
 */
function isJson(str) {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

/**
 * Tries to parse a string as JSON, returning the original string if parsing fails.
 * @param {string} str The string to try to parse
 * @returns {object|string} Parsed JSON or the original string
 */
function tryParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within the timeout,
 * returns a timeout result instead of waiting forever.
 * @param {Promise} promise The promise to wrap
 * @param {number} timeoutMs The timeout in milliseconds
 * @param {string} timeoutMessage The message to return on timeout
 * @returns {Promise} The result of the promise or the timeout message
 */
function withTimeout(promise, timeoutMs, timeoutMessage) {
    return Promise.race([
        promise,
        new Promise((resolve) => {
            setTimeout(() => {
                resolve(timeoutMessage);
            }, timeoutMs);
        }),
    ]);
}

/**
 * Stringifies an object if it is not already a string.
 * @param {any} obj The object to stringify
 * @returns {string} A JSON string representation of the object.
 */
function stringify(obj) {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function formatToolDisplayValue(value) {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
    }

    return JSON.stringify(value, null, 2);
}

function isToolDisplayMetadataKey(key) {
    const normalized = String(key ?? '').trim().toLowerCase();
    return normalized === 'continue'
        || normalized === 'cwd'
        || normalized === 'workspace'
        || normalized === 'character'
        || normalized === 'filename'
        || normalized === 'url'
        || normalized === 'uri'
        || normalized.includes('filepath')
        || normalized.includes('filepaths')
        || normalized.includes('path');
}

function labelToolDisplayKey(key, labelMap = {}) {
    const rawKey = String(key ?? '');
    return String(labelMap[rawKey] || rawKey);
}

function appendToolMetadataRows(parent, entries) {
    const filteredEntries = entries.filter(entry => String(entry?.value ?? '').trim());
    if (!filteredEntries.length) {
        return;
    }

    const rows = document.createElement('div');
    rows.className = 'tool-display-metadata';

    for (const entry of filteredEntries) {
        const row = document.createElement('div');
        row.className = 'tool-display-metadata-row';

        const label = document.createElement('span');
        label.className = 'tool-display-metadata-label';
        label.textContent = entry.label;

        const value = document.createElement('span');
        value.className = 'tool-display-metadata-value';
        value.textContent = entry.value;

        row.append(label, value);
        rows.append(row);
    }

    parent.append(rows);
}

function appendToolPayloadBlock(parent, label, payload, language = 'json') {
    if (payload === undefined || payload === null || payload === '') {
        return;
    }

    const section = document.createElement('div');
    section.className = 'tool-display-payload';

    const title = document.createElement('div');
    title.className = 'tool-display-payload-label';
    title.textContent = label;

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (language) {
        code.classList.add(`language-${language}`);
    }
    code.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

    pre.append(code);
    section.append(title, pre);
    parent.append(section);
}

function splitToolDisplayObject(value, { labelMap = {}, path = [] } = {}) {
    if (Array.isArray(value)) {
        const metadata = [];
        const payload = [];

        value.forEach((item, index) => {
            const split = splitToolDisplayObject(item, { labelMap: {}, path: [...path, String(index)] });
            metadata.push(...split.metadata);
            if (split.hasPayload) {
                payload.push(split.payload);
            }
        });

        return {
            metadata,
            payload,
            hasPayload: payload.length > 0,
        };
    }

    if (!isPlainObject(value)) {
        return {
            metadata: [],
            payload: value,
            hasPayload: value !== undefined && value !== null && value !== '',
        };
    }

    const metadata = [];
    const payload = {};

    for (const [key, entryValue] of Object.entries(value)) {
        const displayKey = labelToolDisplayKey(key, path.length === 0 ? labelMap : {});
        const displayPath = [...path, displayKey].join('.');

        if (isToolDisplayMetadataKey(key)) {
            metadata.push({
                label: displayPath,
                value: formatToolDisplayValue(entryValue),
            });
            continue;
        }

        const split = splitToolDisplayObject(entryValue, { labelMap: {}, path: [...path, displayKey] });
        metadata.push(...split.metadata);
        if (split.hasPayload) {
            payload[displayKey] = split.payload;
        }
    }

    return {
        metadata,
        payload,
        hasPayload: Object.keys(payload).length > 0,
    };
}

function maskNativeToolThinkingBlocks(text) {
    const source = String(text ?? '');
    return source.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, match => ' '.repeat(match.length));
}

function escapeRegExp(str) {
    return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAbsoluteOrRootedPath(value) {
    const filepath = String(value ?? '').trim();
    return /^[A-Za-z]:[\\/]/.test(filepath)
        || filepath.startsWith('\\\\')
        || filepath.startsWith('/')
        || filepath.startsWith('\\');
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function unescapeXmlText(value) {
    return String(value ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function normalizeSchemaType(schema) {
    const schemaType = schema?.type;
    if (Array.isArray(schemaType)) {
        return schemaType.find(type => type !== 'null') || schemaType[0] || null;
    }

    return typeof schemaType === 'string' ? schemaType : null;
}

function serializeNativeToolValue(value) {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    return String(value ?? '');
}

function getNativeToolOrderedEntries(value, schema) {
    const objectValue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const schemaProperties = schema?.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties)
        : [];
    const seen = new Set();
    const entries = [];

    for (const key of schemaProperties) {
        if (Object.hasOwn(objectValue, key)) {
            entries.push([key, objectValue[key]]);
            seen.add(key);
        }
    }

    for (const [key, entryValue] of Object.entries(objectValue)) {
        if (!seen.has(key)) {
            entries.push([key, entryValue]);
        }
    }

    return entries;
}

function formatNativeToolValueXml(tagName, value, schema, indentLevel = 0) {
    const indent = '  '.repeat(indentLevel);
    const schemaType = normalizeSchemaType(schema);

    if (Array.isArray(value)) {
        const itemSchema = schemaType === 'array' ? schema?.items : null;
        return value
            .map(item => formatNativeToolValueXml(tagName, item, itemSchema, indentLevel))
            .filter(Boolean)
            .join('\n');
    }

    if (schemaType === 'object' || (value && typeof value === 'object' && !Array.isArray(value))) {
        const childLines = getNativeToolOrderedEntries(value, schema)
            .map(([childName, childValue]) => formatNativeToolValueXml(childName, childValue, schema?.properties?.[childName], indentLevel + 1))
            .filter(Boolean);

        if (childLines.length === 0) {
            return `${indent}<${tagName}></${tagName}>`;
        }

        return `${indent}<${tagName}>\n${childLines.join('\n')}\n${indent}</${tagName}>`;
    }

    const serialized = escapeXmlText(serializeNativeToolValue(value));
    return `${indent}<${tagName}>${serialized}</${tagName}>`;
}

function formatNativeToolResultContent(content) {
    return `<result>\n${String(content ?? '')}\n</result>`;
}

function formatNativeToolCallXml(toolCall) {
    const toolName = String(toolCall?.tool ?? '').trim();
    const args = toolCall?.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
        ? toolCall.args
        : {};
    const continueValue = toolCall?.continue !== false;
    const lines = [`<${toolName}>`];

    for (const [argName, value] of Object.entries(args)) {
        lines.push(formatNativeToolValueXml(argName, value, null, 1));
    }

    lines.push(`  <continue>${continueValue ? 'true' : 'false'}</continue>`);
    lines.push(`</${toolName}>`);
    return lines.join('\n');
}

function findNativeXmlCloseTagIndex(source, tagName, fromIndex) {
    return source.indexOf(`</${String(tagName ?? '')}>`, fromIndex);
}

function matchNativeXmlOpenTagAt(source, index, allowedTagNames = null) {
    if (source[index] !== '<' || source[index + 1] === '/') {
        return null;
    }

    const rawMatch = /^<([A-Za-z_][A-Za-z0-9_.:-]*)>/.exec(source.slice(index));
    if (!rawMatch) {
        return null;
    }

    const name = rawMatch[1];
    if (Array.isArray(allowedTagNames) && allowedTagNames.length > 0 && !allowedTagNames.includes(name)) {
        return null;
    }

    return {
        name,
        openTag: rawMatch[0],
        openStart: index,
        openEnd: index + rawMatch[0].length,
    };
}

function findNextNativeXmlSiblingStart(source, startIndex, allowedTagNames = null) {
    for (let index = startIndex; index < source.length; index++) {
        if (source[index] !== '<') {
            continue;
        }

        if (index > 0 && !/\s/.test(source[index - 1])) {
            continue;
        }

        const match = matchNativeXmlOpenTagAt(source, index, allowedTagNames);
        if (match) {
            return match.openStart;
        }
    }

    return -1;
}

function extractNativeXmlChildBlocks(content, allowedTagNames = null) {
    const source = String(content ?? '').replace(/\r\n/g, '\n');
    const blocks = [];
    let index = 0;

    while (index < source.length) {
        while (index < source.length && /\s/.test(source[index])) {
            index++;
        }

        if (index >= source.length) {
            break;
        }

        const openMatch = matchNativeXmlOpenTagAt(source, index, allowedTagNames);
        if (!openMatch) {
            return blocks.length > 0 ? blocks : null;
        }

        const closeIndex = findNativeXmlCloseTagIndex(source, openMatch.name, openMatch.openEnd);
        const siblingIndex = closeIndex === -1
            ? findNextNativeXmlSiblingStart(source, openMatch.openEnd, allowedTagNames)
            : -1;
        const valueEnd = closeIndex !== -1
            ? closeIndex
            : siblingIndex !== -1
                ? siblingIndex
                : source.length;

        blocks.push({
            name: openMatch.name,
            value: source.slice(openMatch.openEnd, valueEnd),
            hasExplicitClose: closeIndex !== -1,
        });

        const closeTag = `</${openMatch.name}>`;
        index = closeIndex !== -1 ? closeIndex + closeTag.length : valueEnd;
    }

    return blocks;
}

function parseNativeXmlBlocksToObject(childBlocks, schemaProperties = {}) {
    const groupedBlocks = new Map();
    for (const child of childBlocks) {
        if (!groupedBlocks.has(child.name)) {
            groupedBlocks.set(child.name, []);
        }
        groupedBlocks.get(child.name).push(child);
    }

    const result = {};
    for (const [name, blocks] of groupedBlocks.entries()) {
        const childSchema = schemaProperties?.[name];
        const childSchemaType = normalizeSchemaType(childSchema);

        if (childSchemaType === 'array') {
            result[name] = blocks.map(block => parseNativeToolArgumentValue(block.value, childSchema?.items));
            continue;
        }

        if (blocks.length > 1) {
            throw new Error(`Duplicate <${name}> tags are not allowed.`);
        }

        if (blocks.length === 1) {
            result[name] = parseNativeToolArgumentValue(blocks[0].value, childSchema);
            continue;
        }
    }

    return result;
}

function parseNativeToolArgumentValue(rawValue, schema) {
    const value = String(rawValue ?? '').replace(/\r\n/g, '\n');
    const trimmedValue = value.trim();
    const schemaType = normalizeSchemaType(schema);

    if (schemaType === 'boolean') {
        if (/^true$/i.test(trimmedValue)) {
            return true;
        }
        if (/^false$/i.test(trimmedValue)) {
            return false;
        }
        return unescapeXmlText(trimmedValue);
    }

    if (schemaType === 'integer') {
        const parsed = Number.parseInt(trimmedValue, 10);
        return Number.isNaN(parsed) ? unescapeXmlText(trimmedValue) : parsed;
    }

    if (schemaType === 'number') {
        const parsed = Number(trimmedValue);
        return Number.isFinite(parsed) ? parsed : unescapeXmlText(trimmedValue);
    }

    if (schemaType === 'array') {
        if (!trimmedValue) {
            return [];
        }

        return [parseNativeToolArgumentValue(value, schema?.items)];
    }

    if (schemaType === 'object') {
        const schemaProperties = schema?.properties && typeof schema.properties === 'object'
            ? schema.properties
            : {};
        const propertyNames = Object.keys(schemaProperties);
        const childBlocks = extractNativeXmlChildBlocks(value, propertyNames.length > 0 ? propertyNames : null);

        if (childBlocks && childBlocks.length > 0) {
            return parseNativeXmlBlocksToObject(childBlocks, schemaProperties);
        }

        return trimmedValue ? unescapeXmlText(trimmedValue) : {};
    }

    return unescapeXmlText(trimmedValue);
}

function formatNativeToolParameterDescription(parameter, isRequired) {
    const schemaType = normalizeSchemaType(parameter);
    const description = String(parameter?.description ?? '').trim().replace(/\.$/, '');
    const parts = [];

    if (description) {
        parts.push(description);
    }

    if (Array.isArray(parameter?.enum) && parameter.enum.length > 0) {
        parts.push(`Choices: ${parameter.enum.map(value => String(value)).join(' | ')}`);
    } else if (schemaType === 'array') {
        const itemType = normalizeSchemaType(parameter?.items);
        const childNames = Object.keys(parameter?.items?.properties ?? {});
        parts.push('Repeat this tag once per value');
        if (itemType === 'object') {
            parts.push(childNames.length > 0 ? `Inside each tag, use child tags: ${childNames.join(', ')}` : 'Inside each tag, use nested child tags');
        }
    } else if (schemaType === 'object') {
        const childNames = Object.keys(parameter?.properties ?? {});
        parts.push(childNames.length > 0 ? `Use nested child tags: ${childNames.join(', ')}` : 'Use nested child tags');
    }

    if (!isRequired) {
        parts.push('Optional');
    }

    return parts.join('. ').trim() + '.';
}

function formatNativeToolDescription(name, description, displayName) {
    const trimmed = String(description ?? '').trim();

    if (name === 'execute_shell') {
        return 'Runs PowerShell.';
    }

    if (name === 'execute_python') {
        return 'Runs Python.';
    }

    if (trimmed) {
        return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
    }

    if (displayName) {
        return `Uses ${displayName}.`;
    }

    return 'Runs this tool.';
}

const LIST_DIRECTORY_CONTEXT_TIMEOUT_MS = 3000;
const LIST_DIRECTORY_CONTEXT_TIMEOUT_RESULT = '__list_directory_context_timeout__';
const LIST_DIRECTORY_CONTEXT_MAX_CHARS = 4000;
const NEW_WORKSPACE_OPTION = '__new_workspace__';
const WORKSPACE_SEPARATOR_OPTION = '__workspace_separator__';
const NATIVE_TOOL_CALLING_MIGRATION_NOTICE_KEY = 'native_tool_calling_xml_notice_dismissed';
const activeShellRuns = new Map();
const activePythonRuns = new Map();
const pendingShellRenders = new Set();
const sdToolModelsCache = {
    modelNames: [],
};
const MCP_TOOL_CONTEXT_CHAR_LIMIT = 10_000;
const MCP_TOOL_CONTENT_PREVIEW_LIMIT = 4_000;
const MCP_RESOURCE_PREVIEW_LIMIT = 6_000;
const MCP_CONTEXT_UPDATED_EVENT = 'st-mcp-context-updated';
const DANGEROUS_TOOLS = ['write_file', 'execute_shell', 'execute_python'];
const TOOL_RESULT_ROLES = ['assistant', 'user', 'system'];
const mcpDiscoveredTools = new Map();
const builtinNativeToolDefinitions = new Map();
const mcpServerStatus = new Map();
let mcpActiveWorkspaceKey = '';
let mcpUiInitialized = false;
let mcpManageButtonInitialized = false;
let mcpRefreshButtonInitialized = false;
let sandboxWorkspaceRefreshButtonInitialized = false;
let sandboxWorkspaceAddButtonInitialized = false;
let sandboxRootPath = '';

function resolveToolRegistrationValue(value) {
    return typeof value === 'function' ? value() : value;
}

function getConfiguredToolResultRole() {
    const role = String(oai_settings.tool_result_role ?? '');
    return TOOL_RESULT_ROLES.includes(role) ? role : 'system';
}

function getCurrentPlatformSyntaxLabel() {
    const userAgentData = /** @type {{ platform?: string } | undefined} */ (navigator).userAgentData;
    const rawPlatform = String(userAgentData?.platform || navigator.platform || '').toLowerCase();

    if (rawPlatform.includes('win')) {
        return 'Windows';
    }

    if (rawPlatform.includes('mac') || rawPlatform.includes('darwin')) {
        return 'macOS';
    }

    if (rawPlatform.includes('linux') || rawPlatform.includes('x11')) {
        return 'Linux';
    }

    return 'Commodore 64';
}

async function refreshSdToolModelsCache() {
    try {
        const response = await fetch('/api/extensions/tools/sd_models', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            sdToolModelsCache.modelNames = [];
            return sdToolModelsCache.modelNames;
        }

        const models = await response.json();
        sdToolModelsCache.modelNames = [...new Set((Array.isArray(models) ? models : [])
            .map(model => String(model?.title || model?.model_name || '').trim())
            .filter(Boolean))];
    } catch {
        sdToolModelsCache.modelNames = [];
    }

    return sdToolModelsCache.modelNames;
}

function getSdTxt2ImgToolParameters() {
    const modelProperty = {
        type: 'string',
        description: 'Checkpoint name.',
    };

    if (sdToolModelsCache.modelNames.length) {
        modelProperty.enum = sdToolModelsCache.modelNames;
    }

    return {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'Postive prompt',
            },
            negative_prompt: {
                type: 'string',
                description: 'Negative prompt',
            },
            model: modelProperty,
            width: {
                type: 'integer',
                description: 'Pixel width',
            },
            height: {
                type: 'integer',
                description: 'Pixel height',
            },
            steps: {
                type: 'integer',
                description: 'Steps 1-150',
            },
            cfg_scale: {
                type: 'number',
                description: 'CFG 1-30',
            },
            sampler_name: {
                type: 'string',
                description: 'Name of the sampler to use',
            },
            seed: {
                type: 'integer',
                description: 'Seed -1 is random',
            },
            alwayson_scripts: {
                type: 'object',
                description: 'Script arguments. See localhost:7860/sdapi/v1/script-info',
            },
        },
        required: ['prompt'],
    };
}

/**
 * Gets a chat message by message ID.
 * @param {number} messageId
 * @returns {any|null}
 */
function getChatMessageById(messageId) {
    return Number.isInteger(messageId) && messageId >= 0 && messageId < chat.length
        ? chat[messageId]
        : null;
}

/**
 * Keeps the serialized tool-result wrapper in sync with structured result content.
 * @param {any} message
 */
function syncToolResultMessageContent(message) {
    if (!message?.extra) {
        return;
    }

    const content = typeof message.extra.tool_result_content === 'string'
        ? message.extra.tool_result_content
        : String(message.extra.tool_result_content ?? '');
    message.extra.tool_result_content = content;
    message.mes = formatNativeToolResultContent(content);
}

/**
 * Schedules a re-render for a live shell result message.
 * @param {number} messageId
 */
function scheduleShellMessageRender(messageId) {
    if (pendingShellRenders.has(messageId)) {
        return;
    }

    pendingShellRenders.add(messageId);
    requestAnimationFrame(() => {
        pendingShellRenders.delete(messageId);
        const message = getChatMessageById(messageId);
        if (!message) {
            return;
        }

        updateMessageBlock(messageId, message);
    });
}

/**
 * Applies a mutation to a live shell result message and re-renders it.
 * @param {number} messageId
 * @param {(message: any) => void} mutator
 */
function updateShellResultMessage(messageId, mutator) {
    const message = getChatMessageById(messageId);
    if (!message?.extra?.shell_command) {
        return;
    }

    mutator(message);
    syncToolResultMessageContent(message);
    scheduleShellMessageRender(messageId);
}

/**
 * Applies a mutation to a live Python result message and re-renders it.
 * @param {number} messageId
 * @param {(message: any) => void} mutator
 */
function updatePythonResultMessage(messageId, mutator) {
    const message = getChatMessageById(messageId);
    if (!message?.extra?.python_command) {
        return;
    }

    mutator(message);
    syncToolResultMessageContent(message);
    scheduleShellMessageRender(messageId);
}

/**
 * Requests that an active shell run stop.
 * @param {number} messageId
 * @returns {Promise<boolean>}
 */
export async function stopActiveShellRun(messageId) {
    const run = activeShellRuns.get(messageId);
    if (!run || run.stopping || run.completed) {
        return false;
    }

    run.stopping = true;
    run.stoppedByUser = true;

    if (!run.runId) {
        run.fetchController?.abort();
        return true;
    }

    try {
        const response = await fetch('/api/extensions/tools/executeshell/stop', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ runId: run.runId }),
        });

        if (response.ok) {
            return true;
        }

        run.fetchController?.abort();
        return false;
    } catch (error) {
        console.error('[execute_shell] Failed to stop PowerShell run:', error);
        run.fetchController?.abort();
        return false;
    }
}

/**
 * Requests that an active Python run stop.
 * @param {number} messageId
 * @returns {Promise<boolean>}
 */
export async function stopActivePythonRun(messageId) {
    const run = activePythonRuns.get(messageId);
    if (!run || run.stopping || run.completed) {
        return false;
    }

    run.stopping = true;
    run.stoppedByUser = true;

    if (!run.runId) {
        run.fetchController?.abort();
        return true;
    }

    try {
        const response = await fetch('/api/extensions/tools/executepython/stop', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ runId: run.runId }),
        });

        if (response.ok) {
            return true;
        }

        run.fetchController?.abort();
        return false;
    } catch (error) {
        console.error('[execute_python] Failed to stop Python run:', error);
        run.fetchController?.abort();
        return false;
    }
}
const ASK_USER_DEFAULT_FREE_FIELD_LABEL = 'Something else';
const ASK_USER_DEFAULT_PLACEHOLDER = 'Something else';
let askUserPanelInitialized = false;
let askUserSession = null;

/**
 * A class that represents a tool definition.
 */
class ToolDefinition {
    /**
     * A unique name for the tool.
     * @type {string}
     */
    #name;

    /**
     * A user-friendly display name for the tool.
     * @type {string}
     */
    #displayName;

    /**
     * A description of what the tool does.
     * @type {string}
     */
    #description;

    /**
     * A JSON schema for the parameters that the tool accepts.
     * @type {object}
     */
    #parameters;

    /**
     * A function that will be called when the tool is executed.
     * @type {function}
     */
    #action;

    /**
     * A function that will be called to format the tool call toast.
     * @type {function}
     */
    #formatMessage;

    /**
     * A function that will be called to determine if the tool should be registered.
     * @type {function}
     */
    #shouldRegister;

    /**
     * A tool call result will not be shown in the chat. No follow-up generation will be performed.
     * @type {boolean}
     */
    #stealth;

    /**
     * Display-only metadata used by chat renderers.
     * @type {object}
     */
    #displayMetadata;

    /**
     * Creates a new ToolDefinition.
     * @param {string} name A unique name for the tool.
     * @param {string} displayName A user-friendly display name for the tool.
     * @param {string} description A description of what the tool does.
     * @param {object} parameters A JSON schema for the parameters that the tool accepts.
     * @param {function} action A function that will be called when the tool is executed.
     * @param {function} formatMessage A function that will be called to format the tool call toast.
     * @param {function} shouldRegister A function that will be called to determine if the tool should be registered.
     * @param {boolean} stealth A tool call result will not be shown in the chat. No follow-up generation will be performed.
     * @param {object} displayMetadata Display-only metadata used by chat renderers.
     */
    constructor(name, displayName, description, parameters, action, formatMessage, shouldRegister, stealth, displayMetadata = {}) {
        this.#name = name;
        this.#displayName = displayName;
        this.#description = description;
        this.#parameters = parameters;
        this.#action = action;
        this.#formatMessage = formatMessage;
        this.#shouldRegister = shouldRegister;
        this.#stealth = stealth;
        this.#displayMetadata = displayMetadata && typeof displayMetadata === 'object' ? displayMetadata : {};
    }

    /**
     * Converts the ToolDefinition to an OpenAI API representation
     * @returns {ToolDefinitionOpenAI} OpenAI API representation of the tool.
     */
    toFunctionOpenAI() {
        return {
            type: 'function',
            function: {
                name: this.#name,
                description: resolveToolRegistrationValue(this.#description),
                parameters: resolveToolRegistrationValue(this.#parameters),
            },
            toString: function () {
                return `<div><b>${this.function.name}</b></div><div><small>${this.function.description}</small></div><pre class="justifyLeft wordBreakAll"><code class="flex padding5">${JSON.stringify(this.function.parameters, null, 2)}</code></pre><hr>`;
            },
        };
    }

    /**
     * Invokes the tool with the given parameters.
     * @param {object} parameters The parameters to pass to the tool.
     * @param {AbortSignal} signal The AbortSignal to use for cancellation.
     * @returns {Promise<any>} The result of the tool's action function.
     */
    async invoke(parameters, signal, context) {
        return await this.#action(parameters, signal, context);
    }

    /**
     * Formats a message with the tool invocation.
     * @param {object} parameters The parameters to pass to the tool.
     * @returns {Promise<string>} The formatted message.
     */
    async formatMessage(parameters) {
        return typeof this.#formatMessage === 'function'
            ? await this.#formatMessage(parameters)
            : `Invoking tool: ${this.#displayName || this.#name}`;
    }

    async shouldRegister() {
        return typeof this.#shouldRegister === 'function'
            ? await this.#shouldRegister()
            : true;
    }

    get displayName() {
        return this.#displayName;
    }

    get name() {
        return this.#name;
    }

    get parameters() {
        return resolveToolRegistrationValue(this.#parameters);
    }

    get displayMetadata() {
        return this.#displayMetadata;
    }

    get stealth() {
        return this.#stealth;
    }
}

/**
 * Creates a ToolDefinition from a registration payload.
 * @param {ToolRegistration} registration Tool registration payload
 * @returns {ToolDefinition} Materialized tool definition
 */
function createToolDefinition(registration) {
    const {
        name,
        displayName,
        description,
        parameters,
        action,
        formatMessage,
        shouldRegister,
        stealth,
        displayMetadata,
    } = registration;

    return new ToolDefinition(
        name,
        displayName,
        description,
        parameters,
        action,
        formatMessage,
        shouldRegister,
        stealth,
        displayMetadata,
    );
}

function getSandboxRequestContext(workspace = getCurrentSandboxWorkspace(), character = getCurrentSandboxCharacterName()) {
    return {
        workspace: String(workspace || SANDBOX_ROOT_WORKSPACE).trim() || SANDBOX_ROOT_WORKSPACE,
        character: String(character || getCurrentSandboxCharacterName()).trim() || getCurrentSandboxCharacterName(),
    };
}

/**
 * Validates a sandbox media file before exposing it as an image/video tool result.
 * @param {string} filepath Sandbox-relative path.
 * @param {{ allowVideo?: boolean }} [options]
 * @returns {Promise<{ kind: 'image'|'video', filepath: string, width?: number, height?: number }>}
 */
async function validateSandboxMediaFile(filepath, { allowVideo = false } = {}) {
    const sandbox = getSandboxRequestContext();
    const response = await fetch('/api/extensions/tools/media-info', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            filepath,
            allowVideo,
            ...sandbox,
        }),
    });
    const result = await response.json();

    if (!response.ok) {
        throw new Error(result?.error || 'An unknown media validation error occurred.');
    }

    return result;
}

function ensureMcpSettingsShape() {
    if (!power_user.mcp || typeof power_user.mcp !== 'object') {
        power_user.mcp = { servers: [], workspaces: {} };
    }

    if (!Array.isArray(power_user.mcp.servers)) {
        power_user.mcp.servers = [];
    }

    if (!power_user.mcp.workspaces || typeof power_user.mcp.workspaces !== 'object' || Array.isArray(power_user.mcp.workspaces)) {
        power_user.mcp.workspaces = {};
    }

    return power_user.mcp;
}

function getCurrentMcpWorkspaceKey(workspace = getCurrentSandboxWorkspace()) {
    return String(workspace || SANDBOX_ROOT_WORKSPACE).trim() || SANDBOX_ROOT_WORKSPACE;
}

function getMcpWorkspaceLabel(workspace = getCurrentSandboxWorkspace()) {
    const key = getCurrentMcpWorkspaceKey(workspace);
    return key === SANDBOX_ROOT_WORKSPACE ? 'uploads' : key;
}

function getMcpWorkspaceState(workspace = getCurrentSandboxWorkspace()) {
    const settings = ensureMcpSettingsShape();
    const key = getCurrentMcpWorkspaceKey(workspace);
    if (!settings.workspaces[key] || typeof settings.workspaces[key] !== 'object') {
        settings.workspaces[key] = {
            enabledServerIds: [],
            selectedResources: [],
            selectedPrompts: [],
        };
    }

    if (!Array.isArray(settings.workspaces[key].enabledServerIds)) {
        settings.workspaces[key].enabledServerIds = [];
    }

    if (!Array.isArray(settings.workspaces[key].selectedResources)) {
        settings.workspaces[key].selectedResources = [];
    }

    if (!Array.isArray(settings.workspaces[key].selectedPrompts)) {
        settings.workspaces[key].selectedPrompts = [];
    }

    return settings.workspaces[key];
}

function getChatMcpState() {
    return getMcpWorkspaceState();
}

function getAllMcpServers() {
    return ensureMcpSettingsShape().servers.map(normalizeMcpServerConfig);
}

function setAllMcpServers(servers) {
    const normalized = Array.isArray(servers) ? servers.map(normalizeMcpServerConfig) : [];
    const validIds = new Set(normalized.map(server => server.id));
    const settings = ensureMcpSettingsShape();

    settings.servers = normalized;

    for (const state of Object.values(settings.workspaces)) {
        if (!state || typeof state !== 'object') {
            continue;
        }

        if (Array.isArray(state.enabledServerIds)) {
            state.enabledServerIds = state.enabledServerIds.filter(serverId => validIds.has(serverId));
        }

        if (Array.isArray(state.selectedResources)) {
            state.selectedResources = state.selectedResources.filter(item => validIds.has(item.serverId));
        }

        if (Array.isArray(state.selectedPrompts)) {
            state.selectedPrompts = state.selectedPrompts.filter(item => validIds.has(item.serverId));
        }
    }

    saveSettingsDebounced();
}

function getEnabledServerIdsForWorkspace(workspace = getCurrentSandboxWorkspace()) {
    return [...new Set(getMcpWorkspaceState(workspace).enabledServerIds.map(id => String(id || '').trim()).filter(Boolean))];
}

function setEnabledServerIdsForWorkspace(workspace, serverIds) {
    getMcpWorkspaceState(workspace).enabledServerIds = [...new Set((Array.isArray(serverIds) ? serverIds : []).map(id => String(id || '').trim()).filter(Boolean))];
    saveSettingsDebounced();
}

function isMcpServerEnabledForWorkspace(serverId, workspace = getCurrentSandboxWorkspace()) {
    return getEnabledServerIdsForWorkspace(workspace).includes(String(serverId || '').trim());
}

function setMcpServerEnabledForWorkspace(serverId, enabled, workspace = getCurrentSandboxWorkspace()) {
    const normalizedId = String(serverId || '').trim();
    if (!normalizedId) {
        return;
    }

    const nextIds = new Set(getEnabledServerIdsForWorkspace(workspace));
    if (enabled) {
        nextIds.add(normalizedId);
    } else {
        nextIds.delete(normalizedId);
    }

    setEnabledServerIdsForWorkspace(workspace, [...nextIds]);
}

function createClientUuid() {
    return typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const MCP_DISCOVERY_SOURCES = {
    officialRegistry: {
        name: 'Official MCP Registry',
        browseUrl: 'https://modelcontextprotocol.io/registry/about',
        description: 'The vendor-neutral public registry for published MCP servers.',
    },
    glama: {
        name: 'Glama',
        browseUrl: 'https://glama.ai/',
        description: 'A large community directory with install snippets, tool search, and hosted connectors.',
    },
    mcpDirectory: {
        name: 'MCP.Directory',
        browseUrl: 'https://mcp.directory/',
        description: 'A community catalog focused on discovery and one-click install snippets.',
    },
    claude: {
        name: 'Claude Directory',
        browseUrl: 'https://claude.ai/directory',
        description: 'Anthropic\'s curated directory. Good for discovery, but not a general SillyTavern import feed.',
    },
    chatgptApps: {
        name: 'ChatGPT Apps',
        browseUrl: 'https://help.openai.com/en/articles/11487775/',
        description: 'OpenAI\'s apps directory and setup docs. Useful for learning what exists, but not a drop-in MCP registry for SillyTavern.',
    },
};

function normalizeMcpServerConfig(server = {}) {
    const rawTransportType = String(server.transportType ?? 'stdio').trim().toLowerCase();
    const transportType = rawTransportType === 'http' || rawTransportType === 'streamable-http'
        ? 'http'
        : rawTransportType === 'sse'
            ? 'sse'
            : 'stdio';
    const oauth = server.oauth && typeof server.oauth === 'object' ? server.oauth : {};
    return {
        id: String(server.id || createClientUuid()).trim(),
        name: String(server.name || '').trim(),
        description: String(server.description || '').trim(),
        iconUrl: String(server.iconUrl || server.icon || server.logoUrl || '').trim(),
        version: String(server.version || '').trim(),
        status: String(server.status || '').trim(),
        websiteUrl: String(server.websiteUrl || server.website || '').trim(),
        repositoryUrl: String(server.repositoryUrl || server.sourceUrl || server.source || '').trim(),
        docsUrl: String(server.docsUrl || server.documentationUrl || '').trim(),
        enabled: server.enabled !== false,
        transportType,
        authType: String(server.authType || server.auth?.type || 'none').trim().toLowerCase() === 'oauth' ? 'oauth' : 'none',
        authRequired: server.authRequired === true,
        command: String(server.command || '').trim(),
        argsText: Array.isArray(server.args)
            ? server.args.map(arg => String(arg ?? '').trim()).filter(Boolean).join('\n')
            : String(server.argsText || '').trim(),
        cwd: String(server.cwd || '').trim(),
        envText: typeof server.env === 'object' && server.env !== null
            ? Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\n')
            : String(server.envText || '').trim(),
        url: String(server.url || '').trim(),
        headersText: typeof server.headers === 'object' && server.headers !== null
            ? Object.entries(server.headers).map(([key, value]) => `${key}: ${value}`).join('\n')
            : String(server.headersText || '').trim(),
        oauth: {
            redirectUrl: String(oauth.redirectUrl || server.oauthRedirectUrl || '').trim(),
            clientId: String(oauth.clientId || server.oauthClientId || '').trim(),
            clientSecret: String(oauth.clientSecret || server.oauthClientSecret || '').trim(),
            scope: String(oauth.scope || server.oauthScope || '').trim(),
        },
        timeoutMs: Number.isFinite(Number(server.timeoutMs)) ? Number(server.timeoutMs) : 30000,
        unsafeStdioConfirmed: server.unsafeStdioConfirmed === true,
    };
}

function openExternalLink(url) {
    const safeUrl = String(url || '').trim();
    if (!safeUrl) {
        return;
    }

    window.open(safeUrl, '_blank', 'noopener,noreferrer');
}

function deriveMcpNameFromIdentifier(identifier, fallback = 'MCP Server') {
    const normalized = String(identifier || '')
        .trim()
        .split(/[\\/]/)
        .pop()
        ?.replace(/^@/, '')
        ?.replace(/[:@].*$/, '')
        ?.replace(/\.(mcpb|exe|cmd|bat|sh)$/i, '')
        ?.replace(/[-_]+/g, ' ')
        ?.trim();
    return normalized || fallback;
}

function createMcpHeaderTemplate(headers = []) {
    return headers
        .map(header => String(header?.name || '').trim())
        .filter(Boolean)
        .map(name => `${name}: `)
        .join('\n');
}

function buildMcpDraftFromRegistryRemote(entry, remote, index = 0) {
    const transportType = String(remote?.type || '').toLowerCase() === 'sse' ? 'sse' : 'http';
    const suffix = index > 0 ? ` ${index + 1}` : '';
    return normalizeMcpServerConfig({
        name: `${entry.title || entry.name || 'MCP Server'}${suffix}`,
        description: String(entry.description || '').trim(),
        iconUrl: String(entry.iconUrl || entry.icon || entry.logoUrl || '').trim(),
        version: String(entry.version || '').trim(),
        status: String(entry.status || '').trim(),
        websiteUrl: String(entry.websiteUrl || '').trim(),
        repositoryUrl: String(entry.repositoryUrl || '').trim(),
        docsUrl: String(entry.links?.docsUrl || '').trim(),
        transportType,
        enabled: true,
        url: String(remote?.url || '').trim(),
        headersText: createMcpHeaderTemplate(Array.isArray(remote?.headers) ? remote.headers : []),
        authRequired: Array.isArray(remote?.headers) && remote.headers.some(header => header?.isRequired || header?.isSecret),
    });
}

function buildMcpDraftFromRegistryPackage(entry, pkg, index = 0) {
    const registryType = String(pkg?.registryType || '').trim().toLowerCase();
    const identifier = String(pkg?.identifier || '').trim();
    const version = String(pkg?.version || '').trim();
    const suffix = index > 0 ? ` ${index + 1}` : '';
    const base = {
        name: `${entry.title || entry.name || deriveMcpNameFromIdentifier(identifier)}${suffix}`,
        transportType: 'stdio',
        enabled: true,
    };

    if (!identifier) {
        return null;
    }

    if (registryType === 'npm') {
        return normalizeMcpServerConfig({
            ...base,
            description: String(entry.description || '').trim(),
            iconUrl: String(entry.iconUrl || entry.icon || entry.logoUrl || '').trim(),
            version: String(entry.version || '').trim(),
            status: String(entry.status || '').trim(),
            websiteUrl: String(entry.websiteUrl || '').trim(),
            repositoryUrl: String(entry.repositoryUrl || '').trim(),
            docsUrl: String(entry.links?.docsUrl || '').trim(),
            command: 'npx',
            args: ['-y', version ? `${identifier}@${version}` : identifier],
        });
    }

    if (registryType === 'pypi') {
        return normalizeMcpServerConfig({
            ...base,
            description: String(entry.description || '').trim(),
            iconUrl: String(entry.iconUrl || entry.icon || entry.logoUrl || '').trim(),
            version: String(entry.version || '').trim(),
            status: String(entry.status || '').trim(),
            websiteUrl: String(entry.websiteUrl || '').trim(),
            repositoryUrl: String(entry.repositoryUrl || '').trim(),
            docsUrl: String(entry.links?.docsUrl || '').trim(),
            command: 'uvx',
            args: [version ? `${identifier}==${version}` : identifier],
        });
    }

    if (registryType === 'oci') {
        return normalizeMcpServerConfig({
            ...base,
            description: String(entry.description || '').trim(),
            iconUrl: String(entry.iconUrl || entry.icon || entry.logoUrl || '').trim(),
            version: String(entry.version || '').trim(),
            status: String(entry.status || '').trim(),
            websiteUrl: String(entry.websiteUrl || '').trim(),
            repositoryUrl: String(entry.repositoryUrl || '').trim(),
            docsUrl: String(entry.links?.docsUrl || '').trim(),
            command: 'docker',
            args: ['run', '-i', '--rm', identifier],
        });
    }

    return null;
}

function getMcpRegistryInstallOptions(entry) {
    const remotes = Array.isArray(entry?.remotes) ? entry.remotes : [];
    const packages = Array.isArray(entry?.packages) ? entry.packages : [];
    const options = [];

    remotes.forEach((remote, index) => {
        const headers = Array.isArray(remote?.headers) ? remote.headers : [];
        const requiredHeaders = headers.filter(header => header?.isRequired);
        options.push({
            key: `remote:${index}`,
            kind: 'remote',
            title: `${String(remote?.type || '').toLowerCase() === 'sse' ? 'SSE' : 'HTTP'} endpoint`,
            description: String(remote?.url || '').trim(),
            detail: requiredHeaders.length > 0
                ? `This endpoint needs ${requiredHeaders.length} header${requiredHeaders.length === 1 ? '' : 's'}. SillyTavern will prefill the header names so you can add your values before saving.`
                : 'SillyTavern will add the endpoint so you can review it before saving.',
            draft: buildMcpDraftFromRegistryRemote(entry, remote, index),
            remote,
        });
    });

    packages.forEach((pkg, index) => {
        const registryType = String(pkg?.registryType || '').trim().toLowerCase();
        const supportedDraft = buildMcpDraftFromRegistryPackage(entry, pkg, index);
        const prettyType = registryType ? registryType.toUpperCase() : 'Package';
        options.push({
            key: `package:${index}`,
            kind: 'package',
            title: `${prettyType} package`,
            description: String(pkg?.identifier || '').trim(),
            detail: supportedDraft
                ? `This will run the server locally over stdio using ${supportedDraft.command}. Review the command before saving.`
                : `This package type is published in the registry, but SillyTavern does not know the safest default launch command for it yet.`,
            draft: supportedDraft,
            pkg,
        });
    });

    return options;
}

function getMcpServersForWorkspace(workspace = getCurrentSandboxWorkspace()) {
    const enabledIds = new Set(getEnabledServerIdsForWorkspace(workspace));
    return getAllMcpServers().map(server => normalizeMcpServerConfig({
        ...server,
        enabled: enabledIds.has(server.id),
    }));
}

function getMcpServers() {
    return getMcpServersForWorkspace();
}

function setMcpServersForWorkspace(workspace, servers) {
    const normalized = Array.isArray(servers) ? servers.map(normalizeMcpServerConfig) : [];
    setAllMcpServers(normalized);
    setEnabledServerIdsForWorkspace(workspace, normalized.filter(server => server.enabled).map(server => server.id));
}

function setMcpServers(servers) {
    setMcpServersForWorkspace(getCurrentMcpWorkspaceKey(), servers);
}

function getMcpServerById(serverId) {
    return getMcpServers().find(server => server.id === serverId) || null;
}

function getMcpStatusSummaryElement() {
    const element = document.getElementById('mcp_status_summary');
    return element instanceof HTMLElement ? element : null;
}

function getMcpContextSummaryElement() {
    const element = document.getElementById('mcp_context_summary');
    return element instanceof HTMLElement ? element : null;
}

function getMcpOverviewElement() {
    const element = document.getElementById('mcp_overview');
    return element instanceof HTMLElement ? element : null;
}

function getMcpManageButtonElement() {
    const element = document.getElementById('mcp_manage_button');
    return element instanceof HTMLButtonElement ? element : null;
}

function getMcpRefreshButtonElement() {
    const element = document.getElementById('mcp_refresh_button');
    return element instanceof HTMLButtonElement ? element : null;
}

function purgeMcpSelectionsForServer(serverId, workspace = getCurrentSandboxWorkspace()) {
    const normalizedId = String(serverId || '').trim();
    const settings = ensureMcpSettingsShape();
    const workspaceKeys = workspace === null
        ? Object.keys(settings.workspaces)
        : [getCurrentMcpWorkspaceKey(workspace)];

    for (const key of workspaceKeys) {
        const state = getMcpWorkspaceState(key);
        state.selectedResources = state.selectedResources.filter(item => item.serverId !== normalizedId);
        state.selectedPrompts = state.selectedPrompts.filter(item => item.serverId !== normalizedId);
        state.enabledServerIds = state.enabledServerIds.filter(id => id !== normalizedId);
    }

    saveSettingsDebounced();
}

function isMcpServerInstalled(serverDraft) {
    return getAllMcpServers().some(server => {
        if (server.transportType !== serverDraft.transportType) {
            return false;
        }

        if (server.transportType === 'stdio') {
            return server.command === serverDraft.command && server.argsText === serverDraft.argsText;
        }

        return server.url === serverDraft.url;
    });
}

function getMcpServerStatusTone(server, status) {
    if (status?.testing) {
        return { label: 'Testing...', tone: 'muted' };
    }

    if (status?.lastError) {
        return { label: 'Error', tone: 'error' };
    }

    if (!server.enabled) {
        return { label: 'Disabled', tone: 'muted' };
    }

    if (status?.connected) {
        return { label: 'Connected', tone: 'success' };
    }

    return { label: 'Not connected', tone: 'muted' };
}

function createMcpBadge(label, tone = 'default') {
    const badge = document.createElement('span');
    badge.className = `mcp-badge mcp-badge--${tone}`;
    badge.textContent = label;
    return badge;
}

function createMcpLink(href, label) {
    const link = document.createElement('a');
    link.className = 'mcp-link';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    return link;
}

function createMcpActionLink(href, label) {
    const link = document.createElement('a');
    link.className = 'menu_button mcp-link-button';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    return link;
}

function createMcpIcon(iconUrl, fallbackText) {
    const icon = document.createElement('div');
    icon.className = 'mcp-server-icon';

    if (iconUrl) {
        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = fallbackText;
        image.loading = 'lazy';
        image.addEventListener('error', () => {
            image.remove();
            icon.textContent = String(fallbackText || '?').slice(0, 2).toUpperCase();
        }, { once: true });
        icon.append(image);
        return icon;
    }

    icon.textContent = String(fallbackText || '?').slice(0, 2).toUpperCase();
    return icon;
}

async function disconnectWorkspaceMcpServers(workspace) {
    const servers = getMcpServersForWorkspace(workspace);
    for (const server of servers) {
        if (!mcpServerStatus.get(server.id)?.connected) {
            clearMcpToolsForServer(server.id);
            removeMcpStatus(server.id);
            continue;
        }

        try {
            await disconnectMcpServer(server, { workspace });
        } catch {
            clearMcpToolsForServer(server.id);
            removeMcpStatus(server.id);
        }
    }
}

async function syncActiveMcpWorkspace({ forceRefresh = false, notify = false } = {}) {
    const workspace = getCurrentMcpWorkspaceKey();
    const workspaceChanged = mcpActiveWorkspaceKey !== workspace;

    if (workspaceChanged && mcpActiveWorkspaceKey) {
        await disconnectWorkspaceMcpServers(mcpActiveWorkspaceKey);
    }

    mcpActiveWorkspaceKey = workspace;

    if (workspaceChanged || forceRefresh) {
        await refreshAllMcpServers({ notify });
    } else {
        refreshMcpSummaryUi();
    }
}

async function callMcpApi(endpoint, payload, { signal } = {}) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
        signal,
    });
    const data = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }));
    if (!response.ok) {
        const error = new Error(String(data?.error || response.statusText || 'Request failed.'));
        error.requiresAuth = data?.requiresAuth === true;
        error.authUrl = String(data?.authUrl || '').trim();
        throw error;
    }
    return data;
}

function sanitizeMcpIdentifierPart(value, fallback = 'tool') {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const safe = normalized || fallback;
    return /^[a-z_]/.test(safe) ? safe : `_${safe}`;
}

function hashMcpString(value) {
    let hash = 0;
    const input = String(value ?? '');
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function buildUniqueMcpAlias(baseAlias, existingAliases, entropySource) {
    if (!existingAliases.has(baseAlias)) {
        return baseAlias;
    }

    const suffix = hashMcpString(entropySource).slice(0, 6);
    let candidate = `${baseAlias}_${suffix}`;
    let counter = 2;
    while (existingAliases.has(candidate)) {
        candidate = `${baseAlias}_${suffix}_${counter}`;
        counter++;
    }

    return candidate;
}

function mapMcpInputSchema(tool) {
    const schema = tool?.inputSchema && typeof tool.inputSchema === 'object'
        ? structuredClone(tool.inputSchema)
        : { type: 'object', properties: {} };
    const rawProperties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required.map(name => String(name)) : []);
    const existingAliases = new Set();
    const aliasToOriginal = {};
    const propertyAliases = {};
    const mappedProperties = {};

    for (const [originalName, originalSchema] of Object.entries(rawProperties)) {
        const aliasBase = sanitizeMcpIdentifierPart(originalName, 'arg');
        const alias = buildUniqueMcpAlias(aliasBase, existingAliases, `${tool?.name}:${originalName}`);
        existingAliases.add(alias);
        aliasToOriginal[alias] = originalName;
        propertyAliases[originalName] = alias;
        mappedProperties[alias] = {
            ...(originalSchema && typeof originalSchema === 'object' ? structuredClone(originalSchema) : {}),
            description: alias === originalName
                ? String(originalSchema?.description || '').trim()
                : [String(originalSchema?.description || '').trim(), `Original MCP field: ${originalName}.`].filter(Boolean).join(' '),
        };
    }

    schema.type = 'object';
    schema.properties = mappedProperties;
    schema.required = Array.from(required)
        .map(name => propertyAliases[name])
        .filter(Boolean);

    return {
        schema,
        aliasToOriginal,
    };
}

function isMcpToolRisky(tool) {
    const annotations = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
    if (annotations.readOnlyHint === true) {
        return false;
    }

    return annotations.destructiveHint === true
        || annotations.openWorldHint === true
        || Object.keys(annotations).length === 0;
}

function formatMcpToolDescription(server, tool) {
    const description = String(tool?.description || tool?.title || '').trim();
    const prefix = `MCP tool from ${server.name || server.id}.`;
    const risk = isMcpToolRisky(tool) ? 'Ask before using if the action seems risky.' : '';
    return [prefix, description, risk].filter(Boolean).join(' ');
}

function formatMcpContentItem(item) {
    if (!item || typeof item !== 'object') {
        return '';
    }

    if (item.type === 'text') {
        return String(item.text || '').trim();
    }

    if (item.type === 'resource_link') {
        return `Resource link: ${item.name || item.uri || 'resource'}${item.uri ? ` (${item.uri})` : ''}`;
    }

    if (item.type === 'resource') {
        return `Embedded resource: ${item.resource?.uri || item.uri || item.name || 'resource'}`;
    }

    if (item.type === 'image') {
        return `Image output${item.mimeType ? ` (${item.mimeType})` : ''}.`;
    }

    if (item.type === 'audio') {
        return `Audio output${item.mimeType ? ` (${item.mimeType})` : ''}.`;
    }

    return JSON.stringify(item, null, 2);
}

function formatMcpToolResultPayload(payload) {
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : payload;
    const parts = [];

    if (result?.isError) {
        parts.push('The MCP server reported an error.');
    }

    if (Array.isArray(result?.content)) {
        const contentText = result.content
            .map(formatMcpContentItem)
            .filter(Boolean)
            .join('\n\n')
            .trim();
        if (contentText) {
            parts.push(contentText);
        }
    }

    if (typeof result?.structuredContent !== 'undefined') {
        parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
    }

    if (!parts.length) {
        parts.push(JSON.stringify(result, null, 2));
    }

    return parts.join('\n\n').trim();
}

function mapMcpInvocationArguments(args, aliasToOriginal) {
    const mapped = {};
    for (const [alias, value] of Object.entries(args || {})) {
        mapped[aliasToOriginal[alias] || alias] = value;
    }
    return mapped;
}

async function confirmMcpToolInvocation(server, tool) {
    if (power_user.tool_bypass_mcp_mutable_warning) {
        return true;
    }

    if (!isMcpToolRisky(tool)) {
        return true;
    }

    const confirmed = await Popup.show.confirm(
        'Run MCP Tool',
        [
            `<p><strong>${DOMPurify.sanitize(tool.title || tool.name || 'Tool')}</strong> comes from MCP server <strong>${DOMPurify.sanitize(server.name || server.id)}</strong>.</p>`,
            '<p>This tool is not marked read-only, so it may modify data, access external systems, or have other side effects.</p>',
            '<p>Do you want to continue?</p>',
        ].join(''),
        {
            leftAlign: true,
        },
    );

    return confirmed === 1;
}

function upsertMcpStatus(serverId, status) {
    mcpServerStatus.set(serverId, {
        ...(mcpServerStatus.get(serverId) ?? {}),
        ...status,
    });
}

function clearMcpToolsForServer(serverId) {
    for (const [alias, entry] of mcpDiscoveredTools.entries()) {
        if (entry.serverId === serverId) {
            mcpDiscoveredTools.delete(alias);
        }
    }
}

function rebuildMcpToolCacheForServer(server, tools) {
    clearMcpToolsForServer(server.id);
    const existingAliases = new Set(mcpDiscoveredTools.keys());

    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!tool?.name) {
            continue;
        }

        const baseAlias = `mcp_${sanitizeMcpIdentifierPart(server.name || server.id, 'server')}_${sanitizeMcpIdentifierPart(tool.name, 'tool')}`;
        const alias = buildUniqueMcpAlias(baseAlias, existingAliases, `${server.id}:${tool.name}`);
        existingAliases.add(alias);

        const mappedSchema = mapMcpInputSchema(tool);
        const displayName = `${server.name || server.id}: ${tool.title || tool.name}`;

        mcpDiscoveredTools.set(alias, {
            alias,
            serverId: server.id,
            toolName: tool.name,
            tool,
            registration: {
                name: alias,
                displayName,
                description: formatMcpToolDescription(server, tool),
                parameters: mappedSchema.schema,
                displayMetadata: {
                    type: 'mcp',
                    serverId: server.id,
                    serverName: server.name || server.id,
                    toolName: tool.name,
                    toolTitle: tool.title || tool.name,
                    argumentLabels: mappedSchema.aliasToOriginal,
                },
                action: async (args, signal) => {
                    const currentServer = getMcpServerById(server.id);
                    if (!currentServer) {
                        return new Error(`MCP server "${server.name || server.id}" is no longer configured.`);
                    }

                    if (!currentServer.enabled) {
                        return new Error(`MCP server "${currentServer.name || currentServer.id}" is disabled.`);
                    }

                    const confirmed = await confirmMcpToolInvocation(currentServer, tool);
                    if (!confirmed) {
                        return 'Tool execution was cancelled by the user.';
                    }

                    const response = await callMcpApi('/api/extensions/tools/mcp/tools/call', {
                        serverId: currentServer.id,
                        toolName: tool.name,
                        arguments: mapMcpInvocationArguments(args, mappedSchema.aliasToOriginal),
                        ...getSandboxRequestContext(),
                    }, { signal });

                    upsertMcpStatus(currentServer.id, {
                        connected: true,
                        lastError: '',
                    });
                    refreshMcpSummaryUi();
                    return formatMcpToolResultPayload(response);
                },
                formatMessage: async () => `Invoking MCP tool: ${displayName}`,
            },
        });
    }
}

function registerMcpToolsFromCache() {
    for (const entry of mcpDiscoveredTools.values()) {
        ToolManager.registerFunctionTool(entry.registration);
    }
}

function syncToolRegistryAfterMcpChange() {
    if (oai_settings.native_tool_calling) {
        ToolManager.registerNativeToolCommand();
    }
}

async function completeMcpOAuth(server, authError, retryEndpoint) {
    const authUrl = String(authError?.authUrl || '').trim();
    if (!authUrl) {
        throw authError;
    }

    const opened = window.open(authUrl, '_blank', 'noopener,noreferrer');
    if (!opened) {
        toastr.info(authUrl, 'Open this MCP authorization URL');
    }

    const code = await Popup.show.input(
        'Authorize MCP Server',
        [
            `<p>Complete authorization for <strong>${DOMPurify.sanitize(server.name || server.id)}</strong>, then paste the returned code here.</p>`,
            `<p><a href="${DOMPurify.sanitize(authUrl)}" target="_blank" rel="noopener noreferrer">Open authorization page</a></p>`,
        ].join(''),
        '',
        {
            rows: 3,
            leftAlign: true,
            okButton: 'Authorize',
            cancelButton: 'Cancel',
        },
    );

    if (code === null) {
        throw authError;
    }

    const result = await callMcpApi('/api/extensions/tools/mcp/auth/finish', {
        server,
        code,
        ...getSandboxRequestContext(),
    });

    if (retryEndpoint && !result?.snapshot) {
        return await callMcpApi(retryEndpoint, {
            server,
            ...getSandboxRequestContext(),
        });
    }

    return result;
}

async function refreshMcpServer(server, { reconnect = false, workspace = getCurrentSandboxWorkspace(), character = getCurrentSandboxCharacterName() } = {}) {
    const endpoint = reconnect ? '/api/extensions/tools/mcp/connect' : '/api/extensions/tools/mcp/refresh';
    let result;
    try {
        result = await callMcpApi(endpoint, {
            server,
            ...getSandboxRequestContext(workspace, character),
        });
    } catch (error) {
        if (!error?.requiresAuth) {
            throw error;
        }

        result = await completeMcpOAuth(server, error, endpoint);
    }

    let snapshot = result?.snapshot ?? {};
    const shouldRetryStdioRefresh = reconnect && server.transportType === 'stdio';

    if (shouldRetryStdioRefresh) {
        const followUp = await callMcpApi('/api/extensions/tools/mcp/refresh', {
            server,
            ...getSandboxRequestContext(workspace, character),
        });
        result = followUp;
        snapshot = followUp?.snapshot ?? {};
    }

    rebuildMcpToolCacheForServer(server, snapshot.tools || []);
    upsertMcpStatus(server.id, {
        connected: snapshot.connected === true,
        lastError: '',
        toolCount: Array.isArray(snapshot.tools) ? snapshot.tools.length : 0,
        resourceCount: (Array.isArray(snapshot.resources) ? snapshot.resources.length : 0) + (Array.isArray(snapshot.resourceTemplates) ? snapshot.resourceTemplates.length : 0),
        promptCount: Array.isArray(snapshot.prompts) ? snapshot.prompts.length : 0,
        instructions: String(snapshot.instructions || '').trim(),
        stderr: String(snapshot.stderr || '').trim(),
    });

    return result;
}

async function probeMcpServer(server, { reconnect = true, workspace = getCurrentSandboxWorkspace(), character = getCurrentSandboxCharacterName() } = {}) {
    const endpoint = reconnect ? '/api/extensions/tools/mcp/connect' : '/api/extensions/tools/mcp/refresh';
    let result;
    try {
        result = await callMcpApi(endpoint, {
            server,
            ...getSandboxRequestContext(workspace, character),
        });
    } catch (error) {
        if (!error?.requiresAuth) {
            throw error;
        }

        result = await completeMcpOAuth(server, error, endpoint);
    }

    let snapshot = result?.snapshot ?? {};
    const shouldRetryStdioRefresh = reconnect && server.transportType === 'stdio';

    if (shouldRetryStdioRefresh) {
        const followUp = await callMcpApi('/api/extensions/tools/mcp/refresh', {
            server,
            ...getSandboxRequestContext(workspace, character),
        });
        result = followUp;
        snapshot = followUp?.snapshot ?? {};
    }

    return { result, snapshot };
}

async function refreshAllMcpServers({ notify = false } = {}) {
    mcpDiscoveredTools.clear();

    const enabledServers = getMcpServers().filter(server => server.enabled);
    for (const server of enabledServers) {
        try {
            await refreshMcpServer(server);
        } catch (error) {
            clearMcpToolsForServer(server.id);
            upsertMcpStatus(server.id, {
                connected: false,
                lastError: String(error?.message || error),
                toolCount: 0,
                resourceCount: 0,
                promptCount: 0,
            });
        }
    }

    syncToolRegistryAfterMcpChange();
    refreshMcpSummaryUi();

    if (notify) {
        toastr.success(`Refreshed ${enabledServers.length} MCP server${enabledServers.length === 1 ? '' : 's'}.`, 'MCP');
    }
}

function removeMcpStatus(serverId) {
    mcpServerStatus.delete(serverId);
}

async function toggleMcpServerEnabled(server, enabled = !server?.enabled) {
    const updated = normalizeMcpServerConfig({ ...server, enabled });
    const status = mcpServerStatus.get(updated.id) ?? {};
    setMcpServerEnabledForWorkspace(updated.id, enabled);

    try {
        if (enabled) {
            await refreshMcpServer(updated, { reconnect: true });
        } else if (status.connected) {
            await disconnectMcpServer(updated);
        } else {
            clearMcpToolsForServer(updated.id);
            removeMcpStatus(updated.id);
        }
    } catch (error) {
        upsertMcpStatus(updated.id, { connected: false, lastError: String(error?.message || error) });
        throw error;
    } finally {
        refreshMcpSummaryUi();
    }

    return updated;
}

function summarizeSelectedMcpContext() {
    const enabledCount = getMcpServers().filter(server => server.enabled).length;
    if (enabledCount === 0) {
        return 'No servers enabled for this workspace.';
    }

    return `${enabledCount} server${enabledCount === 1 ? '' : 's'} enabled for this workspace.`;
}

function createMcpSummaryStat(label, value) {
    const cell = document.createElement('div');
    cell.className = 'mcp-status-cell';

    const labelElement = document.createElement('small');
    labelElement.className = 'mcp-status-label';
    labelElement.textContent = label;

    const valueElement = document.createElement('strong');
    valueElement.className = 'mcp-status-value';
    valueElement.textContent = value;

    cell.append(labelElement, valueElement);
    return cell;
}

function renderMcpOverview() {
    const overviewElement = getMcpOverviewElement();
    if (!overviewElement) {
        return;
    }

    overviewElement.replaceChildren();
    const servers = getMcpServers();

    if (servers.length === 0) {
        const empty = document.createElement('small');
        empty.className = 'mcp-empty-state';
        empty.textContent = 'No MCP servers configured for this workspace.';
        overviewElement.append(empty);
        return;
    }

    for (const server of servers) {
        const status = mcpServerStatus.get(server.id) ?? {};
        const statusTone = getMcpServerStatusTone(server, status);
        const row = document.createElement('div');
        row.className = 'mcp-overview-row';

        const identity = document.createElement('div');
        identity.className = 'mcp-overview-identity';

        const name = document.createElement('strong');
        name.textContent = server.name || server.id || 'MCP Server';
        identity.append(name);

        const meta = document.createElement('div');
        meta.className = 'mcp-card-badges';
        const enabledToggle = document.createElement('button');
        enabledToggle.type = 'button';
        enabledToggle.className = `menu_button tools-mcp-state-toggle mcp-badge mcp-badge--${server.enabled ? 'success' : 'muted'}`;
        enabledToggle.textContent = server.enabled ? 'Enabled' : 'Disabled';
        enabledToggle.addEventListener('click', async () => {
            enabledToggle.disabled = true;
            try {
                await toggleMcpServerEnabled(server, !server.enabled);
            } catch (error) {
                toastr.error(String(error?.message || error), `MCP: ${server.name || server.id}`);
            }
        });
        meta.append(enabledToggle);
        meta.append(createMcpBadge(server.transportType === 'stdio' ? 'stdio' : server.transportType === 'sse' ? 'SSE' : 'HTTP', 'muted'));
        if (server.version) {
            meta.append(createMcpBadge(`v${server.version}`, 'muted'));
        }
        identity.append(meta);

        const summary = document.createElement('div');
        summary.className = 'mcp-overview-summary';
        summary.append(createMcpBadge(`${status.toolCount ?? 0} tool${(status.toolCount ?? 0) === 1 ? '' : 's'}`, 'default'));

        row.append(identity, summary);
        overviewElement.append(row);
    }
}

function refreshMcpSummaryUi() {
    const statusElement = getMcpStatusSummaryElement();
    const contextElement = getMcpContextSummaryElement();
    const servers = getMcpServers();
    const enabledCount = servers.filter(server => server.enabled).length;
    const connectedCount = servers.filter(server => mcpServerStatus.get(server.id)?.connected).length;
    const toolCount = Array.from(mcpDiscoveredTools.values()).length;

    if (statusElement) {
        statusElement.replaceChildren();
        if (servers.length === 0) {
            const empty = document.createElement('small');
            empty.className = 'opacity70p';
            empty.textContent = 'No MCP servers configured.';
            statusElement.append(empty);
        } else {
            statusElement.append(
                createMcpSummaryStat('Enabled', `${enabledCount}/${servers.length}`),
                createMcpSummaryStat('Connected', String(connectedCount)),
                createMcpSummaryStat('Tools Ready', String(toolCount)),
            );
        }
    }

    if (contextElement) {
        contextElement.textContent = '';
    }

    renderMcpOverview();
}

function formatMcpResourceContents(readResult) {
    const contents = Array.isArray(readResult?.result?.contents) ? readResult.result.contents : [];
    const parts = [];

    for (const entry of contents) {
        if (typeof entry?.text === 'string' && entry.text.trim()) {
            parts.push(entry.text.trim());
            continue;
        }

        const uri = String(entry?.uri || '').trim();
        const mimeType = String(entry?.mimeType || '').trim();
        if (uri || mimeType) {
            parts.push(`Binary resource${mimeType ? ` (${mimeType})` : ''}${uri ? ` from ${uri}` : ''}.`);
        }
    }

    const text = parts.join('\n\n').trim();
    if (!text) {
        return 'Resource did not return text content.';
    }

    return text.length > MCP_RESOURCE_PREVIEW_LIMIT
        ? `${text.slice(0, MCP_RESOURCE_PREVIEW_LIMIT)}\n... (truncated)`
        : text;
}

function formatMcpPromptMessages(promptResult) {
    const messages = Array.isArray(promptResult?.result?.messages) ? promptResult.result.messages : [];
    const rendered = messages.map(message => {
        const role = String(message?.role || 'message').trim();
        const content = message?.content;
        if (content?.type === 'text') {
            return `${role}: ${String(content.text || '').trim()}`;
        }

        return `${role}: [${String(content?.type || 'content')}]`;
    }).filter(Boolean).join('\n\n').trim();

    if (!rendered) {
        return 'Prompt did not return text messages.';
    }

    return rendered.length > MCP_RESOURCE_PREVIEW_LIMIT
        ? `${rendered.slice(0, MCP_RESOURCE_PREVIEW_LIMIT)}\n... (truncated)`
        : rendered;
}

async function saveChatMcpState() {
    saveSettingsDebounced();
    refreshMcpSummaryUi();
    document.dispatchEvent(new CustomEvent(MCP_CONTEXT_UPDATED_EVENT));
}

async function addSelectedMcpResource(server, resource) {
    const readResult = await callMcpApi('/api/extensions/tools/mcp/resources/read', {
        serverId: server.id,
        uri: resource.uri,
        ...getSandboxRequestContext(),
    });

    const state = getChatMcpState();
    state.selectedResources = state.selectedResources.filter(item => !(item.serverId === server.id && item.uri === resource.uri));
    state.selectedResources.push({
        serverId: server.id,
        serverName: server.name || server.id,
        uri: resource.uri,
        title: resource.title || resource.name || resource.uri,
        mimeType: resource.mimeType || '',
        content: formatMcpResourceContents(readResult),
    });
    await saveChatMcpState();
}

async function addSelectedMcpPrompt(server, prompt, promptArguments = {}) {
    const promptResult = await callMcpApi('/api/extensions/tools/mcp/prompts/get', {
        serverId: server.id,
        name: prompt.name,
        arguments: promptArguments,
        ...getSandboxRequestContext(),
    });

    const state = getChatMcpState();
    const key = JSON.stringify({ serverId: server.id, name: prompt.name, promptArguments });
    state.selectedPrompts = state.selectedPrompts.filter(item => JSON.stringify({
        serverId: item.serverId,
        name: item.name,
        promptArguments: item.arguments,
    }) !== key);
    state.selectedPrompts.push({
        serverId: server.id,
        serverName: server.name || server.id,
        name: prompt.name,
        title: prompt.title || prompt.name,
        arguments: promptArguments,
        content: formatMcpPromptMessages(promptResult),
    });
    await saveChatMcpState();
}

async function promptForMcpPromptArguments(prompt) {
    const argumentDefs = Array.isArray(prompt?.arguments) ? prompt.arguments : [];
    if (argumentDefs.length === 0) {
        return {};
    }

    const form = document.createElement('div');
    form.className = 'flex-container flexFlowColumn gap10';
    form.innerHTML = '<p>Fill in the prompt arguments. Leave optional fields empty.</p>';

    for (const argument of argumentDefs) {
        const wrapper = document.createElement('label');
        wrapper.className = 'flex-container flexFlowColumn gap5';
        const label = document.createElement('small');
        label.textContent = `${argument.name}${argument.required ? ' *' : ''}`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole';
        input.dataset.argumentName = argument.name;
        input.placeholder = argument.description || '';
        wrapper.append(label, input);
        form.append(wrapper);
    }

    let values = {};
    const popup = new Popup(form, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        okButton: 'Use Prompt',
        cancelButton: 'Cancel',
        onClosing: (instance) => {
            if (instance.result !== 1) {
                return true;
            }

            values = {};
            for (const argument of argumentDefs) {
                const input = instance.dlg.querySelector(`[data-argument-name="${CSS.escape(argument.name)}"]`);
                const value = input instanceof HTMLInputElement ? input.value.trim() : '';
                if (!value && argument.required) {
                    toastr.warning(`Argument "${argument.name}" is required.`);
                    return false;
                }
                if (value) {
                    values[argument.name] = value;
                }
            }

            return true;
        },
    });

    const result = await popup.show();
    return result === 1 ? values : null;
}

function isMissingBrowserArg(value) {
    return value === null || typeof value === 'undefined' || String(value).trim() === '';
}

function validateBrowserToolPayload(action, payload = {}) {
    const requireSessionAndTabActions = new Set([
        'back',
        'click',
        'hover',
        'type',
        'key',
        'wait',
        'domfetch',
        'executejs',
        'screenshot',
        'download',
    ]);

    if (requireSessionAndTabActions.has(action)) {
        if (isMissingBrowserArg(payload.session_id)) {
            return 'Error: session_id is required.';
        }

        if (isMissingBrowserArg(payload.tab_index)) {
            return 'Error: tab_index is required.';
        }
    }

    if (action === 'close' && isMissingBrowserArg(payload.session_id)) {
        return 'Error: session_id is required.';
    }

    if (action === 'tabs') {
        if (isMissingBrowserArg(payload.session_id)) {
            return 'Error: session_id is required.';
        }

        const tabAction = String(payload.action ?? '').trim().toLowerCase();
        if ((tabAction === 'select' || tabAction === 'close') && isMissingBrowserArg(payload.tab_index)) {
            return 'Error: tab_index is required.';
        }
    }

    return null;
}

/**
 * Calls a browser tool endpoint.
 * @param {string} action Browser action name.
 * @param {object} payload Request payload.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<any|string>} Parsed response or error string.
 */
async function callBrowserTool(action, payload = {}, signal) {
    try {
        const sandbox = getSandboxRequestContext();
        const validationError = validateBrowserToolPayload(action, payload);
        if (validationError) {
            return validationError;
        }

        const body = { ...payload, ...sandbox };
        const sendRequest = async (body) => {
            const response = await fetch(`/api/extensions/tools/browser/${action}`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
                signal,
            });
            const result = await response.json().catch(() => ({}));
            return { response, result };
        };

        let { response, result } = await sendRequest(body);
        if (!response.ok) {
            return `Error: ${result?.error || 'An unknown browser error occurred.'}`;
        }

        return result;
    } catch (error) {
        if (error?.name === 'AbortError') {
            return 'Browser action was cancelled by the user.';
        }

        return `Error: Could not connect to the browser tool server. ${error.message}`;
    }
}

/**
 * Adds image display metadata for browser screenshots returned by backend actions.
 * @param {any} result Browser tool result.
 * @returns {any}
 */
function augmentBrowserToolResult(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'];
    const filepath = String(result.filepath ?? '').trim().toLowerCase();
    const mimeType = String(result.mime_type ?? '').trim().toLowerCase();
    const isDownloadedImage = !result.type && filepath && (mimeType.startsWith('image/') || imageExtensions.some(ext => filepath.endsWith(ext)));

    if (result.screenshot_filepath && !result.screenshot) {
        result.screenshot = {
            type: 'image_display',
            filepath: result.screenshot_filepath,
            title: 'Result page after click',
            ...getSandboxRequestContext(),
        };
    }

    if (result.opened_tab_screenshot_filepath && !result.opened_tab_screenshot) {
        result.opened_tab_screenshot = {
            type: 'image_display',
            filepath: result.opened_tab_screenshot_filepath,
            title: 'Opened tab',
            ...getSandboxRequestContext(),
        };
    }

    if (result.pre_click_screenshot_filepath && !result.pre_click_screenshot) {
        result.pre_click_screenshot = {
            type: 'image_display',
            filepath: result.pre_click_screenshot_filepath,
            title: 'Clicked location before click',
            ...getSandboxRequestContext(),
        };
    }

    if (isDownloadedImage && !result.downloaded_file) {
        result.downloaded_file = {
            type: 'image_display',
            filepath: result.filepath,
            ...getSandboxRequestContext(),
        };
    }

    return result;
}

function getAskUserPanelElements() {
    const sendForm = document.getElementById('send_form');
    const panel = document.getElementById('ask_user_panel');
    const title = document.getElementById('ask_user_title');
    const context = document.getElementById('ask_user_context');
    const counter = document.getElementById('ask_user_counter');
    const prevButton = document.getElementById('ask_user_prev');
    const nextButton = document.getElementById('ask_user_next');
    const options = document.getElementById('ask_user_options');
    const dismissButton = document.getElementById('ask_user_dismiss');
    const continueButton = document.getElementById('ask_user_continue');

    if (!(sendForm instanceof HTMLDivElement)
        || !(panel instanceof HTMLDivElement)
        || !(title instanceof HTMLDivElement)
        || !(context instanceof HTMLDivElement)
        || !(counter instanceof HTMLDivElement)
        || !(prevButton instanceof HTMLButtonElement)
        || !(nextButton instanceof HTMLButtonElement)
        || !(options instanceof HTMLDivElement)
        || !(dismissButton instanceof HTMLButtonElement)
        || !(continueButton instanceof HTMLButtonElement)) {
        return null;
    }

    return {
        sendForm,
        panel,
        title,
        context,
        counter,
        prevButton,
        nextButton,
        options,
        dismissButton,
        continueButton,
    };
}

function syncAskUserPanelLayout() {
    autoFitSendTextAreaDebounced();
}

function autoFitAskUserFreeInput(input) {
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
}

function initAskUserPanel() {
    if (askUserPanelInitialized) {
        return true;
    }

    const elements = getAskUserPanelElements();
    if (!elements) {
        return false;
    }

    elements.prevButton.addEventListener('click', () => {
        if (!askUserSession || askUserSession.currentIndex <= 0) {
            return;
        }

        askUserSession.currentIndex -= 1;
        renderAskUserPanel();
    });

    elements.nextButton.addEventListener('click', () => {
        if (!askUserSession || askUserSession.currentIndex >= askUserSession.questionnaire.questions.length - 1) {
            return;
        }

        askUserSession.currentIndex += 1;
        renderAskUserPanel();
    });

    elements.dismissButton.addEventListener('click', () => finishAskUserSession('dismissed'));
    elements.continueButton.addEventListener('click', () => {
        if (!askUserSession) {
            return;
        }

        if (askUserSession.currentIndex < askUserSession.questionnaire.questions.length - 1) {
            askUserSession.currentIndex += 1;
            renderAskUserPanel();
            return;
        }

        finishAskUserSession('completed');
    });

    document.addEventListener('keydown', (event) => {
        if (!askUserSession) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finishAskUserSession('dismissed');
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();

            if (askUserSession.currentIndex < askUserSession.questionnaire.questions.length - 1) {
                askUserSession.currentIndex += 1;
                renderAskUserPanel();
            } else {
                finishAskUserSession('completed');
            }
        }
    });

    askUserPanelInitialized = true;
    return true;
}

function normalizeAskUserOption(option, questionIndex, optionIndex) {
    if (typeof option === 'string') {
        const label = option.trim();
        if (!label) {
            throw new Error(`Question ${questionIndex + 1} option ${optionIndex + 1} must not be empty.`);
        }

        return { label, value: label, selected: false };
    }

    if (typeof option === 'object' && option !== null) {
        const label = String(option.label ?? option.text ?? option.value ?? '').trim();
        const value = String(option.value ?? label).trim();

        if (!label || !value) {
            throw new Error(`Question ${questionIndex + 1} option ${optionIndex + 1} must include a label.`);
        }

        return {
            label,
            value,
            selected: option.selected === true,
        };
    }

    throw new Error(`Question ${questionIndex + 1} option ${optionIndex + 1} must be a string or object.`);
}

function normalizeAskUserStringArray(value) {
    return Array.isArray(value)
        ? value.map(item => String(item ?? '').trim()).filter(Boolean)
        : [];
}

function normalizeAskUserQuestion(question, questionIndex) {
    if (typeof question !== 'object' || question === null) {
        throw new Error(`Question ${questionIndex + 1} must be an object.`);
    }

    const prompt = String(question.prompt ?? question.question ?? '').trim();
    if (!prompt) {
        throw new Error(`Question ${questionIndex + 1} must include a prompt.`);
    }

    const context = String(question.context ?? question.helper_text ?? question.description ?? '').trim();
    if (!context) {
        throw new Error(`Question ${questionIndex + 1} must include context.`);
    }

    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (rawOptions.length === 0) {
        throw new Error(`Question ${questionIndex + 1} must include at least one option.`);
    }
    const options = rawOptions.map((option, optionIndex) => normalizeAskUserOption(option, questionIndex, optionIndex));
    const defaultSelected = new Set(normalizeAskUserStringArray(question.default_selected));
    const selectedValues = Array.from(new Set(options
        .filter(option => option.selected || defaultSelected.has(option.value) || defaultSelected.has(option.label))
        .map(option => option.value)));

    return {
        prompt,
        context,
        options,
        defaultSelected: selectedValues,
        defaultText: String(question.default_answer ?? question.default_text ?? '').trim(),
        placeholder: String(question.placeholder ?? '').trim(),
        freeFieldLabel: String(question.free_field_label ?? '').trim(),
        multiline: question.multiline === true,
    };
}

function normalizeAskUserPayload(payload) {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error('ask_user payload must be an object.');
    }

    if (!Object.hasOwn(payload, 'questions')) {
        throw new Error('ask_user requires a "questions" field.');
    }

    const rawQuestions = Array.isArray(payload.questions)
        ? payload.questions
        : (payload.questions && typeof payload.questions === 'object' ? [payload.questions] : []);

    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        throw new Error('ask_user requires at least one question.');
    }

    return {
        questions: rawQuestions.map((question, questionIndex) => normalizeAskUserQuestion(question, questionIndex)),
    };
}

function renderAskUserPanel() {
    if (!askUserSession) {
        return;
    }

    const { elements, questionnaire, currentIndex, answers } = askUserSession;
    const question = questionnaire.questions[currentIndex];
    const answer = answers[currentIndex];
    const submitCurrentQuestion = () => {
        if (!askUserSession) {
            return;
        }

        if (askUserSession.currentIndex < askUserSession.questionnaire.questions.length - 1) {
            askUserSession.currentIndex += 1;
            renderAskUserPanel();
            return;
        }

        finishAskUserSession('completed');
    };

    elements.title.textContent = question.prompt;
    elements.context.textContent = question.context;
    elements.context.hidden = !question.context;
    elements.counter.textContent = `${currentIndex + 1} of ${questionnaire.questions.length}`;
    elements.prevButton.disabled = currentIndex === 0;
    elements.nextButton.disabled = currentIndex >= questionnaire.questions.length - 1;
    elements.options.replaceChildren();

    question.options.forEach((option, optionIndex) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ask_user_option_row';
        const isSelected = answer.selectedOptions.includes(option.value);
        button.classList.toggle('is-selected', isSelected);
        button.setAttribute('aria-pressed', String(isSelected));

        const index = document.createElement('span');
        index.className = 'ask_user_option_index';
        index.textContent = `${optionIndex + 1}.`;

        const body = document.createElement('span');
        body.className = 'ask_user_option_body';

        const label = document.createElement('span');
        label.className = 'ask_user_option_label';
        label.textContent = option.label;

        const check = document.createElement('i');
        check.className = 'fa-solid fa-check ask_user_option_check';
        check.setAttribute('aria-hidden', 'true');

        body.append(label, check);
        button.append(index, body);
        button.addEventListener('click', () => {
            if (!askUserSession) {
                return;
            }

            const selectedOptions = askUserSession.answers[currentIndex].selectedOptions;
            const valueIndex = selectedOptions.indexOf(option.value);
            const nextSelected = valueIndex === -1;

            if (nextSelected) {
                selectedOptions.push(option.value);
            } else {
                selectedOptions.splice(valueIndex, 1);
            }

            button.classList.toggle('is-selected', nextSelected);
            button.setAttribute('aria-pressed', String(nextSelected));
        });

        elements.options.appendChild(button);
    });

    const freeRow = document.createElement('div');
    freeRow.className = 'ask_user_free_row';

    const freeIndex = document.createElement('span');
    freeIndex.className = 'ask_user_option_index';
    freeIndex.textContent = `${question.options.length + 1}.`;

    const freeBody = document.createElement('div');
    freeBody.className = 'ask_user_free_body';

    const freeInput = question.multiline
        ? document.createElement('textarea')
        : document.createElement('input');
    freeInput.className = 'ask_user_free_input';
    freeInput.placeholder = question.placeholder || question.freeFieldLabel || ASK_USER_DEFAULT_PLACEHOLDER;
    freeInput.setAttribute('aria-label', question.freeFieldLabel || ASK_USER_DEFAULT_FREE_FIELD_LABEL);
    freeInput.value = answer.freeText;
    if (freeInput instanceof HTMLTextAreaElement) {
        freeInput.rows = 3;
    } else {
        freeInput.type = 'text';
    }
    freeInput.addEventListener('input', () => {
        if (!askUserSession) {
            return;
        }

        askUserSession.answers[currentIndex].freeText = freeInput.value;
        autoFitAskUserFreeInput(freeInput);
        syncAskUserPanelLayout();
    });
    freeInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        submitCurrentQuestion();
    });

    freeBody.append(freeInput);
    freeRow.append(freeIndex, freeBody);
    elements.options.appendChild(freeRow);

    autoFitAskUserFreeInput(freeInput);
    syncAskUserPanelLayout();
}

function formatAskUserSessionResult(session, status) {
    if (status !== 'completed') {
        return 'User dismissed the questionnaire.';
    }

    return session.questionnaire.questions.map((question, index) => {
        const answer = session.answers[index];
        const answerParts = [...answer.selectedOptions];

        if (answer.freeText.trim()) {
            answerParts.push(answer.freeText.trim());
        }

        return `Q: ${question.prompt}\nA: ${answerParts.join(', ')}`;
    }).join('\n');
}

function finishAskUserSession(status) {
    if (!askUserSession) {
        return;
    }

    const session = askUserSession;
    askUserSession = null;

    session.cleanupAbort?.();
    session.elements.options.replaceChildren();
    session.elements.title.textContent = '';
    session.elements.context.textContent = '';
    session.elements.context.hidden = true;
    session.elements.panel.hidden = true;
    session.elements.sendForm.classList.remove('ask-user-active');
    syncAskUserPanelLayout();

    const sendTextarea = document.getElementById('send_textarea');
    if (sendTextarea instanceof HTMLTextAreaElement) {
        sendTextarea.focus();
    }

    session.resolve(formatAskUserSessionResult(session, status));
}

async function promptAskUserQuestionnaire(questionnaire, signal) {
    if (askUserSession) {
        return 'Error: ask_user is already waiting for a response.';
    }

    if (!initAskUserPanel()) {
        return 'Error: ask_user panel is not available.';
    }

    const elements = getAskUserPanelElements();
    if (!elements) {
        return 'Error: ask_user panel is not available.';
    }

    return await new Promise((resolve) => {
        const cleanupAbort = () => {
            if (signal instanceof AbortSignal) {
                signal.removeEventListener('abort', abortHandler);
            }
        };

        const abortHandler = () => finishAskUserSession('dismissed');
        if (signal instanceof AbortSignal) {
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        askUserSession = {
            questionnaire,
            answers: questionnaire.questions.map(question => ({
                selectedOptions: [...question.defaultSelected],
                freeText: question.defaultText,
            })),
            currentIndex: 0,
            elements,
            resolve,
            cleanupAbort,
        };

        elements.panel.hidden = false;
        elements.sendForm.classList.add('ask-user-active');
        renderAskUserPanel();
        elements.dismissButton.focus();
    });
}

function registerBuiltinTools() {
    const builtinTools = [
        {
            name: 'ask_user',
            displayName: 'Ask User',
            description: 'Ask questions, the system automatically appends a freeform field. No "something else" option needed',
            parameters: {
                type: 'object',
                properties: {
                    questions: {
                        type: 'array',
                        description: 'Questions',
                        minItems: 1,
                        items: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'Question text',
                                },
                                context: {
                                    type: 'string',
                                    description: 'Help text',
                                },
                                options: {
                                    type: 'array',
                                    description: 'Answer options',
                                    items: {
                                        type: 'string',
                                    },
                                },
                            },
                            required: ['prompt', 'context', 'options'],
                        },
                    },
                },
            },
            formatMessage: async (parameters) => {
                const questionnaire = normalizeAskUserPayload(parameters);
                const firstPrompt = questionnaire.questions[0]?.prompt || 'questionnaire';
                return `Asking the user in the bottom bar: ${firstPrompt}`;
            },
            action: async (parameters, signal) => {
                try {
                    const questionnaire = normalizeAskUserPayload(parameters);
                    return await promptAskUserQuestionnaire(questionnaire, signal);
                } catch (error) {
                    return `Error: ${error.message}`;
                }
            },
        },
        {
            name: 'write_file',
            description: 'Writes text to a file',
            parameters: {
                'type': 'object',
                'properties': {
                    'filepath': {
                        'type': 'string',
                        'description': 'File path',
                    },
                    'content': {
                        'type': 'string',
                        'description': 'File contents',
                    },
                    'overwrite': {
                        'type': 'boolean',
                        'description': 'Overwrite the file contents. Omit this tag to append instead.',
                    },
                },
                'required': ['filepath', 'content'],
            },
            action: async ({ filepath, content, overwrite, append }) => {
                try {
                    const sandbox = getSandboxRequestContext();
                    const response = await fetch('/api/extensions/tools/writefile', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ filepath, content, overwrite, append, ...sandbox }),
                    });

                    const result = await response.json();

                    if (!response.ok) {
                        return `Error: ${result.error || 'An unknown error occurred.'}`;
                    }

                    return result.message;
                } catch (error) {
                    return `Error: Could not connect to the server to write the file. ${error.message}`;
                }
            },
        },
        {
            name: 'read_file',
            description: 'Reads one or more text files',
            parameters: {
                'type': 'object',
                'properties': {
                    'filepath': {
                        'type': 'string',
                        'description': 'File path',
                    },
                    'filepaths': {
                        'type': 'array',
                        'items': { 'type': 'string' },
                        'description': 'File paths',
                        'minItems': 1,
                        'maxItems': 20,
                    },
                },
            },
            action: async ({ filepath, filepaths }, signal) => {
                try {
                    const sandbox = getSandboxRequestContext();

                    const sanitizePaths = (paths) => (paths || [])
                        .map(p => String(p ?? '').trim())
                        .filter(Boolean);

                    const readOne = async (oneFilepath) => {
                        const response = await fetch('/api/extensions/tools/readfile', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({ filepath: oneFilepath, ...sandbox }),
                            signal,
                        });

                        const result = await response.json();

                        if (!response.ok) {
                            return { ok: false, filepath: oneFilepath, error: result?.error || 'An unknown error occurred.' };
                        }

                        return { ok: true, filepath: oneFilepath, content: result?.content ?? '' };
                    };

                    if (Array.isArray(filepaths)) {
                        const paths = sanitizePaths(filepaths);
                        if (paths.length === 0) {
                            return 'Error: "filepaths" must contain at least one filepath.';
                        }
                        if (paths.length > 20) {
                            return 'Error: Too many filepaths. Max is 20.';
                        }

                        const concurrencyLimit = 4;
                        const results = new Array(paths.length);
                        let nextIndex = 0;

                        const worker = async () => {
                            while (nextIndex < paths.length) {
                                const index = nextIndex++;
                                results[index] = await readOne(paths[index]);
                            }
                        };

                        await Promise.all(
                            Array.from({ length: Math.min(concurrencyLimit, paths.length) }, () => worker()),
                        );

                        return results.map((r) => {
                            if (r.ok) {
                                return `=== BEGIN FILE: ${r.filepath} ===\n${r.content}\n=== END FILE: ${r.filepath} ===`;
                            }
                            return `=== BEGIN FILE: ${r.filepath} (ERROR) ===\nError: ${r.error}\n=== END FILE: ${r.filepath} ===`;
                        }).join('\n\n');
                    }

                    const single = String(filepath ?? '').trim();
                    if (!single) {
                        return 'Error: "filepath" is required (or provide "filepaths").';
                    }

                    const singleResult = await readOne(single);
                    if (!singleResult.ok) {
                        return `Error: ${singleResult.error}`;
                    }

                    return singleResult.content;
                } catch (error) {
                    if (error?.name === 'AbortError') {
                        return 'Read was cancelled by the user.';
                    }
                    const errorMessage = `Error: Could not connect to the server to read the file. ${error.message}`;
                    return errorMessage;
                }
            },
        },
        {
            name: 'list_directory',
            description: 'Lists files and directories',
            parameters: {
                'type': 'object',
                'properties': {
                    'path': {
                        'type': 'string',
                        'description': 'Directory path',
                    },
                },
            },
            action: async ({ path = '.' }) => {
                try {
                    const sandbox = getSandboxRequestContext();
                    const response = await fetch('/api/extensions/tools/listdir', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ path, ...sandbox }),
                    });

                    const result = await response.json();

                    if (!response.ok) {
                        const errorMessage = `Error: ${result.error || 'An unknown error occurred.'}`;
                        return errorMessage;
                    }

                    let output = '';
                    if (result.directories.length > 0) {
                        output += 'Directories:\n' + result.directories.map(d => `  - ${d}/`).join('\n') + '\n\n';
                    }
                    if (result.files.length > 0) {
                        output += 'Files:\n' + result.files.map(f => `  - ${f}`).join('\n');
                    }

                    if (output === '') {
                        output = 'The directory is empty.';
                    }

                    const trimmedOutput = output.trim();
                    return trimmedOutput;
                } catch (error) {
                    const errorMessage = `Error: Could not connect to the server to list the directory. ${error.message}`;
                    return errorMessage;
                }
            },
        },
        {
            name: 'display_image',
            description: 'Displays sandbox media to the user',
            parameters: {
                'type': 'object',
                'properties': {
                    'filepath': {
                        'type': 'string',
                        'description': 'Sandbox-relative media path',
                    },
                },
                'required': ['filepath'],
            },
            action: async ({ filepath }) => {
                const sandbox = getSandboxRequestContext();
                const trimmedFilepath = String(filepath ?? '').trim();

                if (!trimmedFilepath) {
                    return 'Error: filepath is required.';
                }

                if (isAbsoluteOrRootedPath(trimmedFilepath)) {
                    return `Error: "${trimmedFilepath}" must be a sandbox-relative path, not an absolute path.`;
                }

                try {
                    const mediaInfo = await validateSandboxMediaFile(trimmedFilepath, { allowVideo: true });
                    const mediaType = mediaInfo.kind === 'video' ? 'video_display' : 'image_display';
                    return JSON.stringify({ type: mediaType, filepath: trimmedFilepath, ...sandbox });
                } catch (error) {
                    return `Error: ${error.message}`;
                }
            },
        },
        {
            name: 'view_image_file',
            description: 'Reads an image instead of showing it to the user',
            parameters: {
                'type': 'object',
                'properties': {
                    'filepath': {
                        'type': 'string',
                        'description': 'Sandbox-relative image path',
                    },
                },
                'required': ['filepath'],
            },
            action: async ({ filepath }) => {
                const trimmedFilepath = String(filepath ?? '').trim();
                const sandbox = getSandboxRequestContext();

                if (!trimmedFilepath) {
                    return 'Error: filepath is required.';
                }

                if (isAbsoluteOrRootedPath(trimmedFilepath)) {
                    return `Error: "${trimmedFilepath}" must be a sandbox-relative path, not an absolute path.`;
                }

                try {
                    await validateSandboxMediaFile(trimmedFilepath);
                    return {
                        type: 'image_context',
                        filepath: trimmedFilepath,
                        ...sandbox,
                    };
                } catch (error) {
                    return `Error: ${error.message}`;
                }
            },
        },
        {
            name: 'execute_shell',
            description: 'Runs a PowerShell command',
            parameters: {
                'type': 'object',
                'properties': {
                    'command': {
                        'type': 'string',
                        'description': 'PowerShell command',
                    },
                    'explanation': {
                        'type': 'string',
                        'description': 'Short explaination',
                    },
                    'cwd': {
                        'type': 'string',
                        'description': 'Working directory',
                    },
                },
                'required': ['command', 'explanation'],
            },
            formatMessage: async ({ explanation, command, cwd }) => explanation?.trim()
                ? `${explanation.trim()}${cwd?.trim() ? ` (cwd: ${cwd.trim()})` : ''}`
                : `Running PowerShell command: ${command}`,
            action: async ({ command, explanation, cwd }, signal, context = {}) => {
                if (typeof command !== 'string' || !command.trim()) {
                    return 'Error: command is required.';
                }

                if (typeof explanation !== 'string' || !explanation.trim()) {
                    return 'Error: explanation is required and must describe what the command does.';
                }

                const sandbox = getSandboxRequestContext();
                const liveMessageId = Number.isInteger(context?.liveMessageId) ? context.liveMessageId : null;
                const fetchController = new AbortController();
                const runState = {
                    completed: false,
                    fetchController,
                    runId: null,
                    stoppedByUser: false,
                    stopping: false,
                };

                let signalCleanup = null;
                if (signal instanceof AbortSignal) {
                    if (signal.aborted) {
                        fetchController.abort();
                    } else {
                        const abortHandler = () => fetchController.abort();
                        signal.addEventListener('abort', abortHandler, { once: true });
                        signalCleanup = () => signal.removeEventListener('abort', abortHandler);
                    }
                }

                if (liveMessageId !== null) {
                    activeShellRuns.set(liveMessageId, runState);
                }

                let fullOutput = '';
                let finalStatus = 'completed';
                let exitCode = null;
                let receivedTerminalEvent = false;

                const applyTerminalStatus = (status, extra = {}) => {
                    finalStatus = status;
                    if (Object.prototype.hasOwnProperty.call(extra, 'exitCode')) {
                        exitCode = extra.exitCode;
                    }

                    if (liveMessageId === null) {
                        return;
                    }

                    updateShellResultMessage(liveMessageId, (message) => {
                        const shellCommand = message.extra.shell_command;
                        shellCommand.status = status;
                        shellCommand.ended_at = Date.now();
                        if (Object.prototype.hasOwnProperty.call(extra, 'exitCode')) {
                            shellCommand.exit_code = extra.exitCode;
                        }
                        if (extra.reason) {
                            shellCommand.stop_reason = extra.reason;
                        }
                    });
                };

                const appendShellOutput = (chunk) => {
                    if (typeof chunk !== 'string' || !chunk) {
                        return;
                    }

                    fullOutput += chunk;
                    if (liveMessageId === null) {
                        return;
                    }

                    updateShellResultMessage(liveMessageId, (message) => {
                        message.extra.tool_result_content += chunk;
                    });
                };

                const applyShellEvent = (event) => {
                    if (!event || typeof event !== 'object') {
                        return;
                    }

                    switch (event.type) {
                        case 'started':
                            runState.runId = typeof event.runId === 'string' ? event.runId : null;
                            if (liveMessageId !== null) {
                                updateShellResultMessage(liveMessageId, (message) => {
                                    const shellCommand = message.extra.shell_command;
                                    shellCommand.status = 'running';
                                    shellCommand.run_id = runState.runId;
                                    shellCommand.command = typeof event.command === 'string' ? event.command : command;
                                    shellCommand.explanation = typeof event.explanation === 'string' ? event.explanation : explanation;
                                    shellCommand.cwd = typeof event.cwd === 'string' && event.cwd.trim() ? event.cwd : (cwd?.trim() || '.');
                                    shellCommand.started_at = Date.now();
                                });
                            }
                            break;
                        case 'stdout':
                        case 'stderr':
                            appendShellOutput(typeof event.chunk === 'string' ? event.chunk : '');
                            break;
                        case 'completed':
                            receivedTerminalEvent = true;
                            applyTerminalStatus('completed', { exitCode: event.exitCode ?? 0 });
                            break;
                        case 'failed':
                            receivedTerminalEvent = true;
                            if (!fullOutput.trim() && typeof event.message === 'string' && event.message) {
                                appendShellOutput(`${event.message}\n`);
                            }
                            applyTerminalStatus('failed', { exitCode: event.exitCode ?? null });
                            break;
                        case 'stopped':
                            receivedTerminalEvent = true;
                            applyTerminalStatus('stopped', {
                                exitCode: event.exitCode ?? null,
                                reason: typeof event.reason === 'string' ? event.reason : null,
                            });
                            break;
                    }
                };

                try {
                    const response = await fetch('/api/extensions/tools/executeshell', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ command, explanation, cwd, ...sandbox }),
                        signal: fetchController.signal,
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        const message = `Error executing command. Status: ${response.status}. Message: ${errorText}`;
                        applyTerminalStatus(runState.stopping ? 'stopped' : 'failed');
                        if (!fullOutput.trim() && liveMessageId !== null) {
                            updateShellResultMessage(liveMessageId, (chatMessage) => {
                                chatMessage.extra.tool_result_content = message;
                            });
                        }
                        return message;
                    }

                    if (!response.body) {
                        throw new Error('PowerShell execution stream was not available.');
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            break;
                        }

                        buffer += decoder.decode(value, { stream: true });
                        let newlineIndex = buffer.indexOf('\n');
                        while (newlineIndex !== -1) {
                            const line = buffer.slice(0, newlineIndex).trim();
                            buffer = buffer.slice(newlineIndex + 1);
                            if (line) {
                                applyShellEvent(JSON.parse(line));
                            }
                            newlineIndex = buffer.indexOf('\n');
                        }
                    }

                    buffer += decoder.decode();
                    if (buffer.trim()) {
                        applyShellEvent(JSON.parse(buffer.trim()));
                    }

                    if (!receivedTerminalEvent) {
                        applyTerminalStatus(runState.stopping ? 'stopped' : 'completed', { exitCode });
                    }

                    const trimmedOutput = fullOutput.trim();
                    if (trimmedOutput) {
                        return trimmedOutput;
                    }

                    if (finalStatus === 'stopped') {
                        return 'PowerShell command was stopped.';
                    }

                    if (finalStatus === 'failed') {
                        return exitCode === null
                            ? 'PowerShell command failed.'
                            : `PowerShell exited with code ${exitCode}.`;
                    }

                    return 'PowerShell command completed with no output.';
                } catch (error) {
                    if (error.name === 'AbortError') {
                        applyTerminalStatus('stopped', { exitCode, reason: runState.stoppedByUser ? 'stopped' : 'aborted' });
                        return fullOutput.trim() || 'PowerShell command was stopped.';
                    }

                    const message = `Error: Could not connect to server. ${error.message}`;
                    applyTerminalStatus('failed', { exitCode });
                    if (!fullOutput.trim() && liveMessageId !== null) {
                        updateShellResultMessage(liveMessageId, (chatMessage) => {
                            chatMessage.extra.tool_result_content = message;
                        });
                    }
                    return message;
                } finally {
                    signalCleanup?.();
                    runState.completed = true;
                    if (liveMessageId !== null) {
                        activeShellRuns.delete(liveMessageId);
                    }
                }
            },
        },
        {
            name: 'execute_python',
            description: 'Runs Python code',
            parameters: {
                'type': 'object',
                'properties': {
                    'code': {
                        'type': 'string',
                        'description': 'Python code',
                    },
                    'timeout_ms': {
                        'type': 'integer',
                        'description': 'Timeout in ms',
                    },
                },
                'required': ['code'],
            },
            action: async ({ code, timeout_ms }, signal, context = {}) => {
                if (typeof code !== 'string' || !code.trim()) {
                    return 'Error: code is required.';
                }

                if (timeout_ms !== undefined && (!Number.isFinite(Number(timeout_ms)) || Number(timeout_ms) <= 0)) {
                    return 'Error: timeout_ms must be a positive number.';
                }

                const sandbox = getSandboxRequestContext();
                const liveMessageId = Number.isInteger(context?.liveMessageId) ? context.liveMessageId : null;
                const fetchController = new AbortController();
                const runState = {
                    completed: false,
                    fetchController,
                    runId: null,
                    stoppedByUser: false,
                    stopping: false,
                };

                let signalCleanup = null;
                if (signal instanceof AbortSignal) {
                    if (signal.aborted) {
                        fetchController.abort();
                    } else {
                        const abortHandler = () => fetchController.abort();
                        signal.addEventListener('abort', abortHandler, { once: true });
                        signalCleanup = () => signal.removeEventListener('abort', abortHandler);
                    }
                }

                if (liveMessageId !== null) {
                    activePythonRuns.set(liveMessageId, runState);
                }

                let fullOutput = '';
                let finalStatus = 'completed';
                let exitCode = null;
                let receivedTerminalEvent = false;

                const applyTerminalStatus = (status, extra = {}) => {
                    finalStatus = status;
                    if (Object.prototype.hasOwnProperty.call(extra, 'exitCode')) {
                        exitCode = extra.exitCode;
                    }

                    if (liveMessageId === null) {
                        return;
                    }

                    updatePythonResultMessage(liveMessageId, (message) => {
                        const pythonCommand = message.extra.python_command;
                        pythonCommand.status = status;
                        pythonCommand.ended_at = Date.now();
                        if (Object.prototype.hasOwnProperty.call(extra, 'exitCode')) {
                            pythonCommand.exit_code = extra.exitCode;
                        }
                        if (Object.prototype.hasOwnProperty.call(extra, 'timeoutMs')) {
                            pythonCommand.timeout_ms = extra.timeoutMs;
                        }
                        if (extra.reason) {
                            pythonCommand.stop_reason = extra.reason;
                        }
                    });
                };

                const appendPythonOutput = (chunk) => {
                    if (typeof chunk !== 'string' || !chunk) {
                        return;
                    }

                    fullOutput += chunk;
                    if (liveMessageId === null) {
                        return;
                    }

                    updatePythonResultMessage(liveMessageId, (message) => {
                        message.extra.tool_result_content += chunk;
                    });
                };

                const applyPythonEvent = (event) => {
                    if (!event || typeof event !== 'object') {
                        return;
                    }

                    switch (event.type) {
                        case 'started':
                            runState.runId = typeof event.runId === 'string' ? event.runId : null;
                            if (liveMessageId !== null) {
                                updatePythonResultMessage(liveMessageId, (message) => {
                                    const pythonCommand = message.extra.python_command;
                                    pythonCommand.status = 'running';
                                    pythonCommand.run_id = runState.runId;
                                    pythonCommand.timeout_ms = Number.isFinite(Number(event.timeoutMs))
                                        ? Math.floor(Number(event.timeoutMs))
                                        : pythonCommand.timeout_ms;
                                    pythonCommand.started_at = Date.now();
                                });
                            }
                            break;
                        case 'stdout':
                        case 'stderr':
                            appendPythonOutput(typeof event.chunk === 'string' ? event.chunk : '');
                            break;
                        case 'completed':
                            receivedTerminalEvent = true;
                            applyTerminalStatus('completed', { exitCode: event.exitCode ?? 0 });
                            break;
                        case 'failed':
                            receivedTerminalEvent = true;
                            if (!fullOutput.trim() && typeof event.message === 'string' && event.message) {
                                appendPythonOutput(`${event.message}\n`);
                            }
                            applyTerminalStatus('failed', { exitCode: event.exitCode ?? null });
                            break;
                        case 'stopped':
                            receivedTerminalEvent = true;
                            applyTerminalStatus('stopped', {
                                exitCode: event.exitCode ?? null,
                                reason: typeof event.reason === 'string' ? event.reason : null,
                            });
                            break;
                        case 'timed_out':
                            receivedTerminalEvent = true;
                            applyTerminalStatus('timed_out', {
                                exitCode: event.exitCode ?? null,
                                timeoutMs: Number.isFinite(Number(event.timeoutMs)) ? Math.floor(Number(event.timeoutMs)) : null,
                            });
                            break;
                    }
                };

                try {
                    const response = await fetch('/api/extensions/tools/executepython', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ code, timeout_ms, ...sandbox }),
                        signal: fetchController.signal,
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        const message = `Error: ${errorText}`;
                        applyTerminalStatus(runState.stopping ? 'stopped' : 'failed');
                        if (!fullOutput.trim() && liveMessageId !== null) {
                            updatePythonResultMessage(liveMessageId, (chatMessage) => {
                                chatMessage.extra.tool_result_content = message;
                            });
                        }
                        return message;
                    }

                    if (!response.body) {
                        throw new Error('Python execution stream was not available.');
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }

                        buffer += decoder.decode(value, { stream: true });
                        let newlineIndex = buffer.indexOf('\n');
                        while (newlineIndex !== -1) {
                            const line = buffer.slice(0, newlineIndex).trim();
                            buffer = buffer.slice(newlineIndex + 1);
                            if (line) {
                                applyPythonEvent(JSON.parse(line));
                            }
                            newlineIndex = buffer.indexOf('\n');
                        }
                    }

                    buffer += decoder.decode();
                    if (buffer.trim()) {
                        applyPythonEvent(JSON.parse(buffer.trim()));
                    }

                    if (!receivedTerminalEvent) {
                        applyTerminalStatus(runState.stopping ? 'stopped' : 'completed', { exitCode });
                    }

                    const trimmedOutput = fullOutput.trim();
                    if (trimmedOutput) {
                        return trimmedOutput;
                    }

                    if (finalStatus === 'stopped') {
                        return 'Python command was stopped.';
                    }

                    if (finalStatus === 'timed_out') {
                        const appliedTimeout = Number.isFinite(Number(timeout_ms)) ? Math.floor(Number(timeout_ms)) : null;
                        return appliedTimeout
                            ? `Python command timed out after ${appliedTimeout} ms.`
                            : 'Python command timed out.';
                    }

                    if (finalStatus === 'failed') {
                        return exitCode === null
                            ? 'Python command failed.'
                            : `Python exited with code ${exitCode}.`;
                    }

                    return 'Python command completed with no output.';
                } catch (error) {
                    if (error.name === 'AbortError') {
                        applyTerminalStatus('stopped', { exitCode, reason: runState.stoppedByUser ? 'stopped' : 'aborted' });
                        return fullOutput.trim() || 'Python command was stopped.';
                    }

                    const errorMessage = `Error: Could not connect to the server or stream was interrupted. ${error.message}`;
                    applyTerminalStatus('failed', { exitCode });
                    if (!fullOutput.trim() && liveMessageId !== null) {
                        updatePythonResultMessage(liveMessageId, (chatMessage) => {
                            chatMessage.extra.tool_result_content = errorMessage;
                        });
                    }
                    return errorMessage;
                } finally {
                    signalCleanup?.();
                    runState.completed = true;
                    if (liveMessageId !== null) {
                        activePythonRuns.delete(liveMessageId);
                    }
                }
            },
        },
        {
            name: 'browser_open',
            description: 'Opens a URL in the browser',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'URL',
                    },
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    new_tab: {
                        type: 'boolean',
                        description: 'Open in a new tab',
                    },
                },
                required: ['url'],
            },
            action: async ({ url, session_id, tab_index, new_tab = false }, signal) => {
                const result = await callBrowserTool('open', { url, session_id, tab_index, new_tab }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_search',
            description: 'Searches the web in the browser',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query',
                    },
                    engine: {
                        type: 'string',
                        description: 'Search engine',
                    },
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    new_tab: {
                        type: 'boolean',
                        description: 'Open in a new tab',
                    },
                },
                required: ['query'],
            },
            action: async ({ query, engine = 'duckduckgo', session_id, tab_index, new_tab = false }, signal) => {
                const result = await callBrowserTool('search', { query, engine, session_id, tab_index, new_tab }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_tabs',
            description: 'Manages browser tabs',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    action: {
                        type: 'string',
                        description: 'list, select, or close',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                },
                required: ['action', 'session_id'],
            },
            action: async ({ session_id, action, tab_index }, signal) => {
                const result = await callBrowserTool('tabs', { session_id, action, tab_index }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_close',
            description: 'Closes a browser session',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                },
                required: ['session_id'],
            },
            action: async ({ session_id }, signal) => {
                return await callBrowserTool('close', { session_id }, signal);
            },
        },
        {
            name: 'browser_go_back',
            description: 'Goes back in browser history',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index }, signal) => {
                const result = await callBrowserTool('back', { session_id, tab_index }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_click',
            description: 'Clicks an element or coordinates in the browser',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    element_index: {
                        type: 'integer',
                        description: 'Element index from dom_fetch',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector',
                    },
                    text: {
                        type: 'string',
                        description: 'Visible text',
                    },
                    text_index: {
                        type: 'integer',
                        description: 'Text match index',
                    },
                    button: {
                        type: 'string',
                        description: 'left, middle, or right',
                    },
                    x: {
                        type: 'number',
                        description: 'Viewport X coordinate',
                    },
                    y: {
                        type: 'number',
                        description: 'Viewport Y coordinate',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, element_index, selector, text, text_index, button, x, y }, signal) => {
                const result = await callBrowserTool('click', { session_id, tab_index, element_index, selector, text, text_index, button, x, y }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_pixel_click',
            description: 'Clicks browser coordinates',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    x: {
                        type: 'number',
                        description: 'Viewport X coordinate to click',
                    },
                    y: {
                        type: 'number',
                        description: 'Viewport Y coordinate to click',
                    },
                },
                required: ['session_id', 'tab_index', 'x', 'y'],
            },
            action: async ({ session_id, tab_index, x, y }, signal) => {
                const result = await callBrowserTool('click', { session_id, tab_index, x, y }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_hover',
            description: 'Hovers an element or coordinates',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    element_index: {
                        type: 'integer',
                        description: 'Element index from dom_fetch',
                    },
                    text: {
                        type: 'string',
                        description: 'Visible text',
                    },
                    text_index: {
                        type: 'integer',
                        description: 'Text match index',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector',
                    },
                    x: {
                        type: 'number',
                        description: 'Viewport X coordinate to hover.',
                    },
                    y: {
                        type: 'number',
                        description: 'Viewport Y coordinate to hover.',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, element_index, selector, text, text_index, x, y }, signal) => {
                const result = await callBrowserTool('hover', { session_id, tab_index, element_index, selector, text, text_index, x, y }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_type',
            description: 'Types into a browser input',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    element_index: {
                        type: 'integer',
                        description: 'Element index from dom_fetch',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector',
                    },
                    text: {
                        type: 'string',
                        description: 'The text to type.',
                    },
                    submit: {
                        type: 'boolean',
                        description: 'Press Enter after typing',
                    },
                },
                required: ['session_id', 'tab_index', 'text'],
            },
            action: async ({ session_id, tab_index, element_index, selector, text, submit = false }, signal) => {
                const result = await callBrowserTool('type', { session_id, tab_index, element_index, selector, text, submit }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_key',
            description: 'Presses keys in the browser',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    key: {
                        type: 'string',
                        description: 'Key or shortcut',
                    },
                    keys: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Keys to press in order',
                    },
                    delay_ms: {
                        type: 'integer',
                        description: 'Delay between keys in ms',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, key, keys, delay_ms }, signal) => {
                const result = await callBrowserTool('key', { session_id, tab_index, key, keys, delay_ms }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_wait',
            description: 'Waits for text or a selector in the browser',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    text: {
                        type: 'string',
                        description: 'Text to wait for',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector to wait for',
                    },
                    timeout_ms: {
                        type: 'integer',
                        description: 'Timeout in ms',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, text, selector, timeout_ms }, signal) => {
                return await callBrowserTool('wait', { session_id, tab_index, text, selector, timeout_ms }, signal);
            },
        },
        {
            name: 'dom_fetch',
            description: 'Fetches DOM content from the browser',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    mode: {
                        type: 'string',
                        description: 'readable, html, text, links, or interactive',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector',
                    },
                    max_chars: {
                        type: 'integer',
                        description: 'Maximum characters',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum items',
                    },
                    offset: {
                        type: 'integer',
                        description: 'Starting offset',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, mode, selector, max_chars, limit, offset }, signal) => {
                return await callBrowserTool('domfetch', { session_id, tab_index, mode, selector, max_chars, limit, offset }, signal);
            },
        },
        {
            name: 'execute_js',
            description: 'Runs JavaScript in the browser',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    code: {
                        type: 'string',
                        description: 'JavaScript code. Return JSON-safe data',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector for element',
                    },
                    arg: {
                        description: 'Argument passed to the code',
                    },
                },
                required: ['session_id', 'tab_index', 'code'],
            },
            action: async ({ session_id, tab_index, code, selector, arg }, signal) => {
                const result = await callBrowserTool('executejs', { session_id, tab_index, code, selector, arg }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'browser_screenshot',
            description: 'Saves a browser screenshot',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    filepath: {
                        type: 'string',
                        description: 'Output file path',
                    },
                    full_page: {
                        type: 'boolean',
                        description: 'Capture full page',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, filepath, full_page = false }, signal) => {
                const result = await callBrowserTool('screenshot', { session_id, tab_index, filepath, full_page }, signal);
                if (typeof result === 'string') {
                    return result;
                }

                return {
                    ...result,
                    ...getSandboxRequestContext(),
                };
            },
        },
        {
            name: 'browser_download',
            description: 'Downloads a file',
            parameters: {
                type: 'object',
                properties: {
                    session_id: {
                        type: 'string',
                        description: 'Browser session ID',
                    },
                    tab_index: {
                        type: 'integer',
                        description: 'Tab index',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector to click',
                    },
                    url: {
                        type: 'string',
                        description: 'Download URL',
                    },
                    filepath: {
                        type: 'string',
                        description: 'Output file path',
                    },
                },
                required: ['session_id', 'tab_index'],
            },
            action: async ({ session_id, tab_index, selector, url, filepath }, signal) => {
                const result = await callBrowserTool('download', { session_id, tab_index, selector, url, filepath }, signal);
                return typeof result === 'string' ? result : augmentBrowserToolResult(result);
            },
        },
        {
            name: 'sd_txt2img',
            description: 'Generates a Stable Diffusion image and saves it to disk.',
            parameters: getSdTxt2ImgToolParameters,
            action: async ({ prompt, negative_prompt, model, width, height, steps, cfg_scale, sampler_name, seed, alwayson_scripts }) => {
                try {
                    const sandbox = getSandboxRequestContext();

                    const payload = {
                        prompt,
                        negative_prompt: negative_prompt || '',
                        model: model || '',
                        width: width || 1024,
                        height: height || 1024,
                        steps: steps || 25,
                        cfg_scale: cfg_scale || 5,
                        sampler_name: sampler_name || 'Euler a',
                        seed: seed ?? -1,
                        ...sandbox,
                    };

                    if (alwayson_scripts) {
                        payload.alwayson_scripts = alwayson_scripts;
                    }

                    const response = await fetch('/api/extensions/tools/sd_txt2img', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify(payload),
                    });

                    if (!response.ok) {
                        const error = await response.json();
                        return `Error generating image: ${error.error || response.statusText}`;
                    }

                    const result = await response.json();
                    return JSON.stringify({
                        type: 'image_display',
                        filepath: result.filepath,
                        info: result.info || 'Image generated successfully.',
                        ...sandbox,
                    });
                } catch (error) {
                    return `Error: Could not connect to Stable Diffusion WebUI. Make sure it is running at localhost:7860 with --api flag. ${error.message}`;
                }
            },
        },
        {
            name: 'bio',
            displayName: 'Update Bio',
            description: 'Appends text to the user\'s bio',
            parameters: {
                'type': 'object',
                'properties': {
                    'text': {
                        'type': 'string',
                        'description': 'Bio text',
                    },
                },
                'required': ['text'],
            },
            action: async ({ text }) => {
                try {
                    if (!text || typeof text !== 'string' || text.trim().length === 0) {
                        return 'Error: No text provided to append to the bio.';
                    }

                    const currentDescription = power_user.persona_description || '';
                    const separator = currentDescription.length > 0 ? '\n' : '';
                    const newDescription = currentDescription + separator + text.trim();

                    // Update the active persona description
                    power_user.persona_description = newDescription;

                    // Update the stored persona descriptor if a persona is active
                    if (user_avatar && power_user.persona_descriptions[user_avatar]) {
                        power_user.persona_descriptions[user_avatar].description = newDescription;
                    } else if (user_avatar) {
                        power_user.persona_descriptions[user_avatar] = {
                            description: newDescription,
                            position: power_user.persona_description_position,
                            depth: power_user.persona_description_depth,
                            role: power_user.persona_description_role,
                            lorebook: power_user.persona_description_lorebook,
                            connections: [],
                        };
                    }

                    // Refresh the UI and save
                    setPersonaDescription();
                    saveSettingsDebounced();

                    return `Successfully appended to bio. The added text is:\n${text}`;
                } catch (error) {
                    return `Error updating bio: ${error.message}`;
                }
            },
        },
    ];
    const imageGenTools = ['sd_txt2img'];
    const browserTools = ['browser_open', 'browser_search', 'browser_tabs', 'browser_close', 'browser_go_back', 'browser_click', 'browser_pixel_click', 'browser_hover', 'browser_type', 'browser_key', 'browser_wait', 'dom_fetch', 'execute_js', 'browser_screenshot', 'browser_download'];

    builtinTools.forEach(tool => {
        if (DANGEROUS_TOOLS.includes(tool.name)) {
            builtinNativeToolDefinitions.set(tool.name, createToolDefinition(tool));
        }

        // Security gate for dangerous tools.
        if (DANGEROUS_TOOLS.includes(tool.name) && !power_user.enable_dangerous_tools) {
            return;
        }
        // Gate for image generation tools.
        if (imageGenTools.includes(tool.name) && !power_user.enable_image_generation) {
            return;
        }
        // Gate for browser automation tools.
        if (browserTools.includes(tool.name) && !power_user.enable_browser_tools) {
            return;
        }
        if (!ToolManager.tools.some(t => t.toFunctionOpenAI().function.name === tool.name)) {
            ToolManager.registerFunctionTool(tool);
        }
    });
}

/**
 * A class that manages the registration and invocation of tools.
 */
export class ToolManager {
    /**
     * A map of tool names to tool definitions.
     * @type {Map<string, ToolDefinition>}
     */
    static #tools = new Map();

    static #INPUT_DELTA_KEY = '__input_json_delta';

    /**
     * The maximum number of times to recurse when parsing tool calls.
     * @type {number}
     */
    static RECURSE_LIMIT = 50;
    static #lastListDirectoryContext = '';

    static #getNativeToolDefinitions() {
        const definitions = new Map();

        for (const tool of this.tools) {
            definitions.set(tool.toFunctionOpenAI().function.name, tool);
        }

        for (const [name, tool] of builtinNativeToolDefinitions.entries()) {
            if (!definitions.has(name)) {
                definitions.set(name, tool);
            }
        }

        return Array.from(definitions.values());
    }

    static #getNativeToolDefinition(name) {
        return this.#tools.get(name) || builtinNativeToolDefinitions.get(name) || null;
    }

    static #getNativeToolTagNames(additionalNames = []) {
        const tagNames = new Set(this.#getNativeToolDefinitions().map(tool => tool.toFunctionOpenAI().function.name));
        for (const name of additionalNames) {
            if (typeof name === 'string' && name.trim()) {
                tagNames.add(name.trim());
            }
        }
        return Array.from(tagNames);
    }

    static #findNextNativeToolTag(text, startIndex = 0, additionalNames = []) {
        const source = String(text ?? '');
        const tagNames = this.#getNativeToolTagNames(additionalNames);
        if (tagNames.length === 0) {
            return null;
        }

        const tagPattern = new RegExp(`<(${tagNames.map(escapeRegExp).join('|')})\\s*>`, 'g');
        tagPattern.lastIndex = Math.max(0, startIndex);

        let directMatch = null;
        const matchedDirect = tagPattern.exec(source);
        if (matchedDirect) {
            directMatch = {
                toolName: matchedDirect[1],
                startIndex: matchedDirect.index,
                openTag: matchedDirect[0],
                closeTag: `</${matchedDirect[1]}>`,
            };
        }

        const allowedNames = new Set(tagNames);
        const genericPattern = /<tool>\s*([\s\S]*?)<\/tool>/g;
        genericPattern.lastIndex = Math.max(0, startIndex);
        let genericMatch = null;
        let match = null;
        while ((match = genericPattern.exec(source)) !== null) {
            const rawContent = String(match[1] ?? '').trim();
            const toolNameMatch = /"tool"\s*:\s*"([^"]+)"/.exec(rawContent);
            const nestedTagMatch = new RegExp(`<(${tagNames.map(escapeRegExp).join('|')})\\s*>`).exec(rawContent);
            const wrappedToolName = String(toolNameMatch?.[1] ?? nestedTagMatch?.[1] ?? '').trim();

            if (!wrappedToolName || !allowedNames.has(wrappedToolName)) {
                continue;
            }

            genericMatch = {
                toolName: 'tool',
                wrappedToolName,
                startIndex: match.index,
                openTag: '<tool>',
                closeTag: '</tool>',
            };
            break;
        }

        if (!genericMatch) {
            return directMatch;
        }

        if (!directMatch || genericMatch.startIndex <= directMatch.startIndex) {
            return genericMatch;
        }

        return directMatch;
    }

    static #findNativeToolTag(text, additionalNames = []) {
        const source = String(text ?? '');
        let searchIndex = 0;
        let lastMatch = null;

        while (searchIndex < source.length) {
            const nextMatch = this.#findNextNativeToolTag(source, searchIndex, additionalNames);
            if (!nextMatch) {
                break;
            }

            lastMatch = nextMatch;
            const closeTag = String(nextMatch.closeTag || `</${nextMatch.toolName}>`);
            const closeTagIndex = source.indexOf(closeTag, nextMatch.startIndex + nextMatch.openTag.length);
            searchIndex = closeTagIndex === -1
                ? nextMatch.startIndex + nextMatch.openTag.length
                : closeTagIndex + closeTag.length;
        }

        return lastMatch;
    }

    /**
     * Returns an Array of all tools that have been registered.
     * @type {ToolDefinition[]}
     */
    static get tools() {
        return Array.from(this.#tools.values());
    }

    static requiresManualApproval(name) {
        return DANGEROUS_TOOLS.includes(String(name ?? '').trim()) && !power_user.enable_dangerous_tools;
    }

    static getToolDisplayInfo(name) {
        const toolName = String(name ?? '').trim();
        const tool = this.#tools.get(toolName) || builtinNativeToolDefinitions.get(toolName);
        if (!tool) {
            return {
                name: toolName,
                displayName: toolName,
                parameters: null,
                argumentLabels: {},
                mcpStatus: null,
                displayMetadata: {},
            };
        }

        const displayMetadata = tool.displayMetadata && typeof tool.displayMetadata === 'object'
            ? tool.displayMetadata
            : {};

        return {
            name: tool.name || toolName,
            displayName: tool.displayName || toolName,
            parameters: tool.parameters ?? null,
            argumentLabels: displayMetadata.argumentLabels && typeof displayMetadata.argumentLabels === 'object'
                ? displayMetadata.argumentLabels
                : {},
            mcpStatus: displayMetadata.type === 'mcp' && displayMetadata.serverId
                ? (mcpServerStatus.get(displayMetadata.serverId) ?? {})
                : null,
            displayMetadata,
        };
    }

    /**
     * Registers a new tool with the tool registry.
     * @param {ToolRegistration} tool The tool to register.
     */
    static registerFunctionTool({ name, displayName, description, parameters, action, formatMessage, shouldRegister, stealth, displayMetadata }) {
        // Convert WIP arguments
        if (typeof arguments[0] !== 'object') {
            [name, description, parameters, action] = arguments;
        }

        if (this.#tools.has(name)) {
            console.warn(`[ToolManager] A tool with the name "${name}" has already been registered. The definition will be overwritten.`);
        }

        const definition = createToolDefinition({
            name,
            displayName,
            description,
            parameters,
            action,
            formatMessage,
            shouldRegister,
            stealth,
            displayMetadata,
        });
        this.#tools.set(name, definition);
        console.log('[ToolManager] Registered function tool:', definition);
    }

    /**
     * Removes a tool from the tool registry.
     * @param {string} name The name of the tool to unregister.
     */
    static unregisterFunctionTool(name) {
        if (!this.#tools.has(name)) {
            return;
        }

        this.#tools.delete(name);
        console.log(`[ToolManager] Unregistered function tool: ${name}`);
    }

    /**
    * Parse tool call parameters -- they're usually JSON, but they can also be empty strings (which are not valid JSON apparently).
    * @param {object} parameters The parameters for a tool call, usually a string with JSON inside
    * @returns {object} The parsed parameters
    */
    static #parseParameters(parameters) {
        return parameters === ''
            ? {}
            : typeof parameters === 'string'
                ? JSON.parse(parameters)
                : parameters;
    }

    /**
     * Invokes a tool by name. Returns the result of the tool's action function.
     * @param {string} name The name of the tool to invoke.
     * @param {object} parameters Function parameters. For example, if the tool requires a "name" parameter, you would pass {name: "value"}.
     * @param {AbortSignal|{ signal?: AbortSignal, liveMessageId?: number }} signalOrOptions Cancellation signal or invocation options.
     * @returns {Promise<string|Error>} The result of the tool's action function. If an error occurs, null is returned. Non-string results are JSON-stringified.
     */
    static async invokeFunctionTool(name, parameters, signalOrOptions) {
        try {
            const tool = this.#tools.get(name) || builtinNativeToolDefinitions.get(name);
            if (!tool) {
                throw new Error(`No tool with the name "${name}" has been registered.`);
            }

            const invokeParameters = this.#parseParameters(parameters);
            const invocationOptions = signalOrOptions instanceof AbortSignal
                ? { signal: signalOrOptions }
                : (signalOrOptions && typeof signalOrOptions === 'object' ? signalOrOptions : {});
            const signal = invocationOptions.signal instanceof AbortSignal
                ? invocationOptions.signal
                : undefined;

            const toolTimeouts = new Map([
                ['browser_open', 90000],
                ['browser_search', 90000],
                ['browser_tabs', 90000],
                ['browser_close', 90000],
                ['browser_go_back', 90000],
                ['browser_click', 90000],
                ['browser_pixel_click', 90000],
                ['browser_hover', 90000],
                ['browser_type', 90000],
                ['browser_key', 90000],
                ['browser_wait', 90000],
                ['dom_fetch', 90000],
                ['execute_js', 90000],
                ['browser_screenshot', 90000],
                ['browser_download', 90000],
            ]);
            const timeoutMs = toolTimeouts.get(name);
            const timeoutMessage = name.startsWith('browser_') || name === 'dom_fetch' || name === 'execute_js'
                ? `Browser tool "${name}" timed out before returning a result.`
                : `Tool "${name}" timed out before returning a result.`;

            const result = timeoutMs
                ? await withTimeout(tool.invoke(invokeParameters, signal, invocationOptions), timeoutMs, timeoutMessage)
                : await tool.invoke(invokeParameters, signal, invocationOptions);

            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (error) {
            console.error(`[ToolManager] An error occurred while invoking the tool "${name}":`, error);

            if (error instanceof Error) {
                error.cause = name;
                return error;
            }

            return new Error('Unknown error occurred while invoking the tool.', { cause: name });
        }
    }

    /**
     * Checks if a tool is a stealth tool.
     * @param {string} name The name of the tool to check.
     * @returns {boolean} Whether the tool is a stealth tool.
     */
    static isStealthTool(name) {
        const tool = this.#tools.get(name) || builtinNativeToolDefinitions.get(name);
        if (!tool) {
            return false;
        }
        return !!tool.stealth;
    }

    /**
     * Formats a message for a tool call by name.
     * @param {string} name The name of the tool to format the message for.
     * @param {object} parameters Function tool call parameters.
     * @returns {Promise<string>} The formatted message for the tool call.
     */
    static async formatToolCallMessage(name, parameters) {
        const tool = this.#tools.get(name) || builtinNativeToolDefinitions.get(name);
        if (!tool) {
            return `Invoked unknown tool: ${name}`;
        }

        try {
            const formatParameters = this.#parseParameters(parameters);
            return await tool.formatMessage(formatParameters);
        } catch (error) {
            console.error(`[ToolManager] An error occurred while formatting the tool call message for "${name}":`, error);
            return `Invoking tool: ${name}`;
        }
    }

    /**
     * Gets the display name of a tool by name.
     * @param {string} name
     * @returns {string} The display name of the tool.
     */
    static getDisplayName(name) {
        const tool = this.#tools.get(name) || builtinNativeToolDefinitions.get(name);
        if (!tool) {
            return name;
        }
        return tool.displayName || name;
    }

    /**
     * Register function tools for the next chat completion request.
     * @param {object} data Generation data
     */
    static async registerFunctionToolsOpenAI(data) {
        const tools = [];

        for (const tool of ToolManager.tools) {
            const register = await tool.shouldRegister();
            if (!register) {
                console.log('[ToolManager] Skipping tool registration:', tool);
                continue;
            }
            tools.push(tool.toFunctionOpenAI());
        }

        if (tools.length) {
            console.log('[ToolManager] Registered function tools:', tools);

            data.tools = tools;
            data.tool_choice = 'auto';
        }
    }

    /**
     * Utility function to parse tool calls from a parsed response.
     * @param {any[]} toolCalls The tool calls to update.
     * @param {any} parsed The parsed response from the OpenAI API.
     * @returns {void}
     */
    static parseToolCalls(toolCalls, parsed) {
        if (!this.isToolCallingSupported()) {
            return;
        }
        if (Array.isArray(parsed?.choices)) {
            for (const choice of parsed.choices) {
                const choiceIndex = (typeof choice.index === 'number') ? choice.index : null;
                const choiceDelta = choice.delta;

                if (choiceIndex === null || !choiceDelta) {
                    continue;
                }

                const toolCallDeltas = choiceDelta?.tool_calls;

                if (!Array.isArray(toolCallDeltas)) {
                    continue;
                }

                if (!Array.isArray(toolCalls[choiceIndex])) {
                    toolCalls[choiceIndex] = [];
                }

                for (const toolCallDelta of toolCallDeltas) {
                    const toolCallIndex = toolCallDelta?.index >= 0 ? toolCallDelta.index : toolCallDeltas.indexOf(toolCallDelta);

                    if (isNaN(toolCallIndex)) {
                        continue;
                    }

                    if (toolCalls[choiceIndex][toolCallIndex] === undefined) {
                        toolCalls[choiceIndex][toolCallIndex] = {};
                    }

                    const targetToolCall = toolCalls[choiceIndex][toolCallIndex];

                    ToolManager.#applyToolCallDelta(targetToolCall, toolCallDelta);
                }
            }
        }
        const cohereToolEvents = ['message-start', 'tool-call-start', 'tool-call-delta', 'tool-call-end'];
        if (cohereToolEvents.includes(parsed?.type) && typeof parsed?.delta?.message === 'object') {
            const choiceIndex = 0;
            const toolCallIndex = parsed?.index ?? 0;

            if (!Array.isArray(toolCalls[choiceIndex])) {
                toolCalls[choiceIndex] = [];
            }

            if (toolCalls[choiceIndex][toolCallIndex] === undefined) {
                toolCalls[choiceIndex][toolCallIndex] = {};
            }

            const targetToolCall = toolCalls[choiceIndex][toolCallIndex];
            ToolManager.#applyToolCallDelta(targetToolCall, parsed.delta.message);
        }
        if (typeof parsed?.content_block === 'object') {
            const choiceIndex = 0;
            const toolCallIndex = parsed?.index ?? 0;

            if (parsed?.content_block?.type === 'tool_use') {
                if (!Array.isArray(toolCalls[choiceIndex])) {
                    toolCalls[choiceIndex] = [];
                }
                if (toolCalls[choiceIndex][toolCallIndex] === undefined) {
                    toolCalls[choiceIndex][toolCallIndex] = {};
                }
                const targetToolCall = toolCalls[choiceIndex][toolCallIndex];
                ToolManager.#applyToolCallDelta(targetToolCall, parsed.content_block);
            }
        }
        if (typeof parsed?.delta === 'object') {
            const choiceIndex = 0;
            const toolCallIndex = parsed?.index ?? 0;
            const targetToolCall = toolCalls[choiceIndex]?.[toolCallIndex];
            if (targetToolCall) {
                if (parsed?.delta?.type === 'input_json_delta') {
                    const jsonDelta = parsed?.delta?.partial_json;
                    if (!targetToolCall[this.#INPUT_DELTA_KEY]) {
                        targetToolCall[this.#INPUT_DELTA_KEY] = '';
                    }
                    targetToolCall[this.#INPUT_DELTA_KEY] += jsonDelta;
                }
            }
        }
        if (parsed?.type === 'content_block_stop') {
            const choiceIndex = 0;
            const toolCallIndex = parsed?.index ?? 0;
            const targetToolCall = toolCalls[choiceIndex]?.[toolCallIndex];
            if (targetToolCall) {
                const jsonDeltaString = targetToolCall[this.#INPUT_DELTA_KEY];
                if (jsonDeltaString) {
                    try {
                        const jsonDelta = { input: JSON.parse(jsonDeltaString) };
                        delete targetToolCall[this.#INPUT_DELTA_KEY];
                        ToolManager.#applyToolCallDelta(targetToolCall, jsonDelta);
                    } catch (error) {
                        console.warn('[ToolManager] Failed to apply input JSON delta:', error);
                    }
                }
            }
        }
        if (Array.isArray(parsed?.candidates)) {
            for (let choiceIndex = 0; choiceIndex < parsed.candidates.length; choiceIndex++) {
                const candidate = parsed.candidates[choiceIndex];
                if (Array.isArray(candidate?.content?.parts)) {
                    for (let partIndex = 0; partIndex < candidate.content.parts.length; partIndex++) {
                        const part = candidate.content.parts[partIndex];
                        if (part.functionCall) {
                            if (!Array.isArray(toolCalls[choiceIndex])) {
                                toolCalls[choiceIndex] = [];
                            }
                            const toolCallIndex = toolCalls[choiceIndex].length;
                            if (toolCalls[choiceIndex][toolCallIndex] === undefined) {
                                toolCalls[choiceIndex][toolCallIndex] = {};
                            }
                            const targetToolCall = toolCalls[choiceIndex][toolCallIndex];
                            ToolManager.#applyToolCallDelta(targetToolCall, part.functionCall);
                        }
                    }
                }
            }
        }
    }

    /**
     * Apply a tool call delta to a target object.
     * @param {object} target The target object to apply the delta to
     * @param {object} delta The delta object to apply
     */
    static #applyToolCallDelta(target, delta) {
        for (const key in delta) {
            if (!Object.prototype.hasOwnProperty.call(delta, key)) continue;
            if (key === '__proto__' || key === 'constructor') continue;

            const deltaValue = delta[key];
            const targetValue = target[key];

            if (deltaValue === null || deltaValue === undefined) {
                // Don't reset the value if it already exists
                if (targetValue) {
                    continue;
                }
                target[key] = deltaValue;
                continue;
            }

            if (typeof deltaValue === 'string') {
                if (typeof targetValue === 'string') {
                    // Concatenate strings
                    target[key] = targetValue + deltaValue;
                } else {
                    target[key] = deltaValue;
                }
            } else if (typeof deltaValue === 'object' && !Array.isArray(deltaValue)) {
                if (typeof targetValue !== 'object' || targetValue === null || Array.isArray(targetValue)) {
                    target[key] = {};
                }
                // Recursively apply deltas to nested objects
                ToolManager.#applyToolCallDelta(target[key], deltaValue);
            } else {
                // Assign other types directly
                target[key] = deltaValue;
            }
        }
    }

    /**
     * Finds and parses a native XML tool call from the LLM response.
     * @param {string} text The text content from the LLM.
     * @param {{ preferredToolName?: string | null }} [options={}] Parse options.
     * @returns {object|null} The parsed tool call and reasoning, or null if not found.
     */
    static #parseNativeToolTag(text, tagMatch) {
        if (!tagMatch) {
            return null;
        }

        const source = String(text ?? '');
        const { toolName, startIndex: toolTagIndex, openTag } = tagMatch;
        const effectiveToolName = String(tagMatch.wrappedToolName || toolName).trim();
        const closeTag = String(tagMatch.closeTag || `</${toolName}>`);
        const toolCloseTagIndex = findNativeXmlCloseTagIndex(source, toolName, toolTagIndex + openTag.length);
        const fallbackToolBlockEndIndex = toolCloseTagIndex !== -1 ? toolCloseTagIndex + closeTag.length : source.length;
        const detectedToolBlock = source.slice(toolTagIndex, fallbackToolBlockEndIndex).trim();
        const rawToolContent = source.slice(toolTagIndex + openTag.length, toolCloseTagIndex !== -1 ? toolCloseTagIndex : source.length);
        const looksLikeToolCallAttempt = detectedToolBlock.startsWith(`<${String(toolName).trim()}>`);

        const buildParseError = (code, message, extra = {}) => {
            const parseError = {
                code,
                message,
                tool_name: effectiveToolName || toolName,
                ...extra,
            };
            console.warn('[ToolManager] Failed to parse native tool call:', parseError);
            return {
                type: 'tool',
                startIndex: toolTagIndex,
                endIndex: fallbackToolBlockEndIndex,
                raw_tool_block: detectedToolBlock,
                raw_xml: detectedToolBlock,
                detected_tool_name: effectiveToolName || toolName,
                tool_call: null,
                continue: true,
                parse_error: parseError,
            };
        };

        try {
            if (toolName === 'tool' && effectiveToolName) {
                const trimmedContent = String(rawToolContent ?? '').trim();

                try {
                    const parsedJson = JSON.parse(trimmedContent);
                    const args = parsedJson?.args && typeof parsedJson.args === 'object' && !Array.isArray(parsedJson.args)
                        ? parsedJson.args
                        : {};
                    const shouldContinue = parsedJson?.continue !== false;
                    const parsed = {
                        tool: effectiveToolName,
                        args,
                        continue: shouldContinue,
                    };

                    console.log(`[ToolManager] Parsed wrapped tool call: ${parsed.tool}, continue flag: ${parsed.continue}`);
                    return {
                        type: 'tool',
                        startIndex: toolTagIndex,
                        endIndex: fallbackToolBlockEndIndex,
                        raw_tool_block: detectedToolBlock,
                        raw_xml: detectedToolBlock,
                        tool_call: parsed,
                        continue: shouldContinue,
                        parse_error: null,
                    };
                } catch {
                    const nestedMatches = this.findAndParseNativeToolCalls(trimmedContent, { preferredToolNames: [effectiveToolName] });
                    const nestedToolSegment = nestedMatches?.segments?.find(segment => segment.type === 'tool' && segment.tool_call);
                    if (nestedToolSegment?.tool_call) {
                        return {
                            type: 'tool',
                            startIndex: toolTagIndex,
                            endIndex: fallbackToolBlockEndIndex,
                            raw_tool_block: detectedToolBlock,
                            raw_xml: detectedToolBlock,
                            tool_call: nestedToolSegment.tool_call,
                            continue: nestedToolSegment.continue !== false,
                            parse_error: null,
                        };
                    }

                    throw new Error('Failed to parse wrapped tool call contents.');
                }
            }

            const schema = this.#getNativeToolDefinition(effectiveToolName)?.toFunctionOpenAI().function.parameters;
            const allowedTagNames = [
                ...Object.keys(schema?.properties ?? {}),
                'continue',
            ];
            const childBlocks = extractNativeXmlChildBlocks(rawToolContent, allowedTagNames);
            if (!childBlocks) {
                throw new Error('Expected XML child tags for tool arguments.');
            }

            const continueBlocks = childBlocks.filter(child => child.name === 'continue');
            const argumentBlocks = childBlocks.filter(child => child.name !== 'continue');
            const args = parseNativeXmlBlocksToObject(argumentBlocks, schema?.properties ?? {});
            const shouldContinue = continueBlocks.length === 0
                ? true
                : !/^false$/i.test(String(continueBlocks[continueBlocks.length - 1].value ?? '').trim());

            const parsed = {
                tool: effectiveToolName,
                args,
                continue: shouldContinue,
            };

            console.log(`[ToolManager] Parsed tool call: ${parsed.tool}, continue flag: ${parsed.continue}`);
            return {
                type: 'tool',
                startIndex: toolTagIndex,
                endIndex: fallbackToolBlockEndIndex,
                raw_tool_block: detectedToolBlock,
                raw_xml: detectedToolBlock,
                tool_call: parsed,
                continue: shouldContinue,
                parse_error: null,
            };
        } catch (error) {
            if (!looksLikeToolCallAttempt) {
                return null;
            }

            return buildParseError('invalid_tool_call', `Failed to parse tool call: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    static containsNativeToolCall(text, additionalNames = []) {
        const parsed = this.findAndParseNativeToolCalls(text, { preferredToolNames: additionalNames });
        return !!parsed?.hasToolCalls;
    }

    static stripNativeToolCallFromText(text, additionalNames = []) {
        const source = String(text ?? '');
        const parsed = this.findAndParseNativeToolCalls(source, { preferredToolNames: additionalNames });
        if (!parsed?.hasToolCalls) {
            return source;
        }

        return parsed.segments
            .filter(segment => segment.type === 'text')
            .map(segment => segment.text)
            .join('');
    }

    static getNativeToolStopStrings() {
        return [...new Set([
            ...this.#getNativeToolTagNames().map(toolName => `</${toolName}>`),
            '</tool>',
        ])];
    }

    static findAndParseNativeToolCalls(text, { preferredToolNames = [] } = {}) {
        const source = String(text ?? '');
        const scanSource = oai_settings.parse_tools_in_thinking_blocks ? source : maskNativeToolThinkingBlocks(source);
        const segments = [];
        let searchIndex = 0;
        let hasToolCalls = false;
        let hasErrors = false;
        let shouldContinue = false;

        while (searchIndex < scanSource.length) {
            const tagMatch = this.#findNextNativeToolTag(scanSource, searchIndex, preferredToolNames);
            if (!tagMatch) {
                if (searchIndex < scanSource.length || segments.length === 0) {
                    segments.push({ type: 'text', text: source.slice(searchIndex) });
                }
                break;
            }

            if (tagMatch.startIndex > searchIndex) {
                segments.push({
                    type: 'text',
                    text: source.slice(searchIndex, tagMatch.startIndex),
                });
            }

            const parsedSegment = this.#parseNativeToolTag(source, tagMatch);
            if (!parsedSegment) {
                searchIndex = tagMatch.startIndex + tagMatch.openTag.length;
                continue;
            }

            segments.push(parsedSegment);
            hasToolCalls = true;
            hasErrors = hasErrors || !!parsedSegment.parse_error;
            if (parsedSegment.tool_call?.continue !== false) {
                shouldContinue = true;
            }
            searchIndex = Math.max(parsedSegment.endIndex, tagMatch.startIndex + tagMatch.openTag.length);
        }

        if (segments.length === 0) {
            segments.push({ type: 'text', text: source });
        }

        return {
            segments,
            hasToolCalls,
            hasErrors,
            shouldContinue,
        };
    }

    static findAndParseNativeToolCall(text, { preferredToolName = null } = {}) {
        const source = String(text ?? '');
        const parsed = this.findAndParseNativeToolCalls(text, {
            preferredToolNames: preferredToolName ? [preferredToolName] : [],
        });
        const toolSegment = parsed?.segments?.findLast?.(segment => segment.type === 'tool')
            ?? [...(parsed?.segments ?? [])].reverse().find(segment => segment.type === 'tool');
        if (!toolSegment) {
            return null;
        }
        const textBeforeTool = parsed.segments
            .slice(0, parsed.segments.indexOf(toolSegment))
            .filter(segment => segment.type === 'text')
            .map(segment => segment.text)
            .join('');
        const thinkMatch = source.match(/<think>([\s\S]*?)<\/think>/);
        const reasoning = thinkMatch ? thinkMatch[1].trim() : '';
        const prefixText = thinkMatch
            ? textBeforeTool.replace(/<think>[\s\S]*?<\/think>/, '')
            : textBeforeTool;

        return {
            tool_call: toolSegment.tool_call,
            parse_error: toolSegment.parse_error,
            continue: toolSegment.continue,
            reasoning,
            prefix_text: prefixText.trim(),
            original_text: source,
        };
    }

    /**
     * Reconstructs the message from the parsed tool call to be displayed in the chat.
     * @param {object} parsedTool The result from findAndParseNativeToolCall.
     * @returns {string} The canonical tool call string.
     */
    static formatNativeToolCallForDisplay(parsedTool) {
        const { tool_call, reasoning, prefix_text } = parsedTool;
        let result = '';

        // Include any text that appeared before the tool call
        if (prefix_text) {
            result += prefix_text;
            if (!prefix_text.endsWith('\n')) {
                result += '\n';
            }
        }

        if (reasoning) {
            result += `<think>${reasoning}</think>\n`;
        }

        result += formatNativeToolCallXml(tool_call);

        return result;
    }

    /**
     * Fetches current uploads directory listing for prompt context.
     * @returns {Promise<string|null>} Formatted context or null when disabled/unavailable.
     */
    static async #getListDirectoryPromptContext() {
        if (!power_user.auto_list_directory_context) {
            return null;
        }

        let listResult = await withTimeout(
            ToolManager.invokeFunctionTool('list_directory', { path: '.' }),
            LIST_DIRECTORY_CONTEXT_TIMEOUT_MS,
            LIST_DIRECTORY_CONTEXT_TIMEOUT_RESULT,
        );

        if (listResult === LIST_DIRECTORY_CONTEXT_TIMEOUT_RESULT) {
            listResult = this.#lastListDirectoryContext
                ? this.#lastListDirectoryContext
                : 'Unavailable: list_directory timed out.';
        } else if (listResult instanceof Error) {
            listResult = this.#lastListDirectoryContext
                ? this.#lastListDirectoryContext
                : `Unavailable: ${listResult.message}`;
        } else {
            listResult = String(listResult ?? '').trim();
            if (listResult.startsWith('Error:')) {
                listResult = this.#lastListDirectoryContext
                    ? this.#lastListDirectoryContext
                    : `Unavailable: ${listResult}`;
            }
        }

        if (typeof listResult !== 'string' || !listResult) {
            return null;
        }

        const trimmedListResult = listResult.length > LIST_DIRECTORY_CONTEXT_MAX_CHARS
            ? `${listResult.slice(0, LIST_DIRECTORY_CONTEXT_MAX_CHARS)}\n... (truncated)`
            : listResult;

        this.#lastListDirectoryContext = trimmedListResult;
        const workspace = getCurrentSandboxWorkspace();
        const workspaceLabel = workspace === SANDBOX_ROOT_WORKSPACE ? 'uploads' : workspace;
        return `Current sandbox workspace listing (workspace "${workspaceLabel}", auto-fetched using list_directory with path "."):\n${trimmedListResult}`;
    }

    static async #getMcpPromptContext() {
        const state = getChatMcpState();
        const parts = [];

        if (state.selectedResources.length > 0) {
            const resources = state.selectedResources.map(resource => {
                const header = `${resource.title || resource.uri} [${resource.serverName}]`;
                return `${header}\n${String(resource.content || '').trim()}`;
            }).join('\n\n');
            parts.push(`Selected MCP resources for this workspace:\n${resources}`);
        }

        if (state.selectedPrompts.length > 0) {
            const prompts = state.selectedPrompts.map(prompt => {
                const argumentText = prompt.arguments && Object.keys(prompt.arguments).length > 0
                    ? `\nArguments: ${JSON.stringify(prompt.arguments)}`
                    : '';
                return `${prompt.title || prompt.name} [${prompt.serverName}]${argumentText}\n${String(prompt.content || '').trim()}`;
            }).join('\n\n');
            parts.push(`Selected MCP prompts for this workspace:\n${prompts}`);
        }

        const combined = parts.filter(Boolean).join('\n\n').trim();
        if (!combined) {
            return null;
        }

        return combined.length > MCP_TOOL_CONTEXT_CHAR_LIMIT
            ? `${combined.slice(0, MCP_TOOL_CONTEXT_CHAR_LIMIT)}\n... (truncated)`
            : combined;
    }

    /**
     * Constructs the system prompt instructions for native tool calling.
     * @returns {Promise<string|null>} The instruction string or null if no tools are available.
     */
    static async getNativeToolPrompt() {
        const nativeTools = this.#getNativeToolDefinitions();
        if (nativeTools.length === 0) {
            return null;
        }

        const needsSdModelContext = nativeTools.some(tool => {
            const name = tool.toFunctionOpenAI().function.name;
            return name === 'sd_txt2img';
        });

        if (needsSdModelContext) {
            await refreshSdToolModelsCache();
        }

        const finalPromptParts = [];
        finalPromptParts.push(`Always put your tool call in your main response. You may include multiple tool calls anywhere in your message.

Call a tool by using the tool name as the XML tag. Put each argument in its own direct child tag. Use ${getCurrentPlatformSyntaxLabel()} syntax always.
Use real XML for every argument.
- Simple values can be inline: <cwd>.</cwd>
- Multiline values can stay multiline inside one tag:
  <code>line 1
line 2
line 3</code>
- For arrays, repeat the same tag once per value.
- For objects, put nested child tags inside the parent tag.
- Never put JSON inside XML tags.
Use <continue>true</continue> when you need the result before replying.
Use <continue>false</continue> when you already gave your full reply and the tool is only a side effect.
Tool results will be returned inside <result> tags.
To provide a non-media file for the user to download, use the syntax \`![](filename.ext)\`
To provide media to the user to download or view, use display_image.

Examples:
<read_file>
<filepaths>docs/a.txt</filepaths>
<filepaths>docs/b.txt</filepaths>
<continue>true</continue>
</read_file>

<ask_user>
<questions>
<prompt>Character direction</prompt>
<context>Choose one direction.</context>
<options>Keep the real VTuber persona</options>
<options>Fictionalize heavily</options>
</questions>
<continue>true</continue>
</ask_user>

Here are the available tools:
`);

        const toolsString = nativeTools.map(tool => {
            const openAITool = tool.toFunctionOpenAI();
            const schema = openAITool.function.parameters;
            const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
            const argumentLines = Object.entries(schema?.properties ?? {}).map(([argName, parameter]) => {
                return `${argName}: ${formatNativeToolParameterDescription(parameter, required.has(argName))}`;
            });
            argumentLines.push('continue: true | false.');

            return [
                openAITool.function.name,
                formatNativeToolDescription(openAITool.function.name, openAITool.function.description, tool.displayName),
                ...argumentLines,
            ].join('\n');
        }).join('\n\n');
        finalPromptParts.push(toolsString);

        const listDirectoryPromptContext = await this.#getListDirectoryPromptContext();
        if (listDirectoryPromptContext) {
            finalPromptParts.push(listDirectoryPromptContext);
        }

        const mcpPromptContext = await this.#getMcpPromptContext();
        if (mcpPromptContext) {
            finalPromptParts.push(mcpPromptContext);
        }

        return finalPromptParts.join('\n\n');
    }

    /**
     * Checks if tool calling is supported for the current settings and generation type.
     * @param {ChatCompletionSettings} settings Optional chat completion settings
     * @param {string} model Optional model name
     * @returns {boolean} Whether tool calling is supported for the given type
     */
    static isToolCallingSupported(settings = null, model = null) {
        settings = settings ?? oai_settings;
        model = model ?? getChatCompletionModel(settings);

        if (main_api !== 'openai' || !settings.function_calling || settings.native_tool_calling) {
            return false;
        }

        // Post-processing will forcefully remove past tool calls from the prompt, making them useless
        const { NONE, MERGE_TOOLS, SEMI_TOOLS, STRICT_TOOLS } = custom_prompt_post_processing_types;
        const allowedPromptPostProcessing = [NONE, MERGE_TOOLS, SEMI_TOOLS, STRICT_TOOLS];
        if (!allowedPromptPostProcessing.includes(settings.custom_prompt_post_processing)) {
            return false;
        }

        const currentModel = Array.isArray(model_list) ? model_list.find(m => m.id === model) : null;
        if (currentModel) {
            switch (settings.chat_completion_source) {
                case chat_completion_sources.POLLINATIONS:
                    return currentModel.tools;
                case chat_completion_sources.FIREWORKS:
                    return currentModel.supports_tools;
                case chat_completion_sources.OPENROUTER:
                    return currentModel.supported_parameters?.includes('tools');
                case chat_completion_sources.MISTRALAI:
                    return currentModel.capabilities?.function_calling;
                case chat_completion_sources.AIMLAPI:
                    return currentModel.features?.includes('openai/chat-completion.function');
                case chat_completion_sources.CHUTES:
                    return currentModel.supported_features?.includes('tools');
                case chat_completion_sources.ELECTRONHUB:
                    return currentModel.metadata?.function_call;
                case chat_completion_sources.WORKERS_AI:
                    return Array.isArray(currentModel.properties) && currentModel.properties.some(p => p.property_id === 'function_calling' && p.value === 'true');
            }
        }

        const supportedSources = [
            chat_completion_sources.OPENAI,
            chat_completion_sources.CUSTOM,
            chat_completion_sources.MISTRALAI,
            chat_completion_sources.CLAUDE,
            chat_completion_sources.OPENROUTER,
            chat_completion_sources.AIMLAPI,
            chat_completion_sources.GROQ,
            chat_completion_sources.COHERE,
            chat_completion_sources.DEEPSEEK,
            chat_completion_sources.MAKERSUITE,
            chat_completion_sources.VERTEXAI,
            chat_completion_sources.AI21,
            chat_completion_sources.XAI,
            chat_completion_sources.POLLINATIONS,
            chat_completion_sources.MOONSHOT,
            chat_completion_sources.FIREWORKS,
            chat_completion_sources.COMETAPI,
            chat_completion_sources.CHUTES,
            chat_completion_sources.ELECTRONHUB,
            chat_completion_sources.AZURE_OPENAI,
            chat_completion_sources.ZAI,
            chat_completion_sources.SILICONFLOW,
            chat_completion_sources.NANOGPT,
            chat_completion_sources.WORKERS_AI,
            chat_completion_sources.MINIMAX,
        ];
        return supportedSources.includes(settings.chat_completion_source);
    }

    /**
     * Checks if tool calls can be performed for the current settings and generation type.
     * @param {string} type Generation type
     * @param {ChatCompletionSettings} settings Optional chat completion settings
     * @param {string} model Optional model name
     * @returns {boolean} Whether tool calls can be performed for the given type
     */
    static canPerformToolCalls(type, settings = null, model = null) {
        settings = settings ?? oai_settings;
        model = model ?? getChatCompletionModel(settings);
        const noToolCallTypes = ['impersonate', 'quiet', 'continue'];
        const isSupported = ToolManager.isToolCallingSupported(settings, model);
        return isSupported && !noToolCallTypes.includes(type);
    }

    /**
     * Utility function to get tool calls from the response data.
     * @param {any} data Response data
     * @returns {any[]} Tool calls from the response data
     */
    static #getToolCallsFromData(data) {
        const getRandomId = () => Math.random().toString(36).substring(2);
        const isClaudeToolCall = c => Array.isArray(c) ? c.filter(x => x).every(isClaudeToolCall) : c?.input && c?.name && c?.id;
        const isGoogleToolCall = c => Array.isArray(c) ? c.filter(x => x).every(isGoogleToolCall) : c?.name && c?.args;
        const convertClaudeToolCall = c => ({ id: c.id, function: { name: c.name, arguments: c.input } });
        const convertGoogleToolCall = (c) => ({ id: getRandomId(), function: { name: c.name, arguments: c.args } });

        // Parsed tool calls from streaming data
        if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
            if (isClaudeToolCall(data[0])) {
                return data[0].filter(x => x).map(convertClaudeToolCall);
            }

            if (isGoogleToolCall(data[0])) {
                return data[0].filter(x => x).map(convertGoogleToolCall);
            }

            if (typeof data[0]?.[0]?.tool_calls === 'object') {
                return Array.isArray(data[0]?.[0]?.tool_calls) ? data[0][0].tool_calls : [data[0][0].tool_calls];
            }

            return data[0];
        }

        // Google AI Studio tool calls
        if (Array.isArray(data?.responseContent?.parts)) {
            return data.responseContent.parts.filter(p => p.functionCall).map(p => convertGoogleToolCall(p.functionCall));
        }

        // Parsed tool calls from non-streaming data
        if (Array.isArray(data?.choices)) {
            // Find a choice with 0-index
            const choice = data.choices.find(choice => choice.index === 0);

            if (choice) {
                return choice.message.tool_calls;
            }
        }

        // Claude tool calls to OpenAI tool calls
        if (Array.isArray(data?.content)) {
            const content = data.content.filter(c => c.type === 'tool_use').map(convertClaudeToolCall);

            if (content) {
                return content;
            }
        }

        // Cohere tool calls
        if (typeof data?.message?.tool_calls === 'object') {
            return Array.isArray(data?.message?.tool_calls) ? data.message.tool_calls : [data.message.tool_calls];
        }
    }

    /**
     * Checks if the response data contains tool calls.
     * @param {object} data Response data
     * @returns {boolean} Whether the response data contains tool calls
     */
    static hasToolCalls(data) {
        const toolCalls = ToolManager.#getToolCallsFromData(data);
        return Array.isArray(toolCalls) && toolCalls.length > 0;
    }

    /**
     * Check for function tool calls in the response data and invoke them.
     * @param {any} data Reply data
     * @returns {Promise<ToolInvocationResult>} Successful tool invocations
     */
    static async invokeFunctionTools(data, { reasoningText = null } = {}) {
        /** @type {ToolInvocationResult} */
        const result = {
            invocations: [],
            errors: [],
            stealthCalls: [],
        };
        const toolCalls = ToolManager.#getToolCallsFromData(data);

        if (!Array.isArray(toolCalls)) {
            return result;
        }

        for (const toolCall of toolCalls) {
            if (!toolCall || !toolCall.function || typeof toolCall.function !== 'object') {
                continue;
            }

            console.log('[ToolManager] Function tool call:', toolCall);
            const id = toolCall.id;
            const parameters = toolCall.function.arguments;
            const name = toolCall.function.name;
            const displayName = ToolManager.getDisplayName(name);
            const isStealth = ToolManager.isStealthTool(name);
            const message = await ToolManager.formatToolCallMessage(name, parameters);
            const toast = message && toastr.info(message, 'Tool Calling', { timeOut: 0 });
            const toolResult = await ToolManager.invokeFunctionTool(name, parameters);
            toastr.clear(toast);
            console.log('[ToolManager] Function tool result:', result);

            // Handle tool errors — still create an invocation so the LLM sees the failure
            if (toolResult instanceof Error) {
                result.errors.push(toolResult);
                if (isStealth) {
                    result.stealthCalls.push(name);
                } else {
                    result.invocations.push({
                        id,
                        displayName,
                        name,
                        parameters: stringify(parameters),
                        result: toolResult.toString(),
                        error: true,
                        signature: toolCall.signature || null,
                        reasoning: reasoningText || null,
                    });
                }
                continue;
            }

            // Don't save stealth tool invocations
            if (isStealth) {
                result.stealthCalls.push(name);
                continue;
            }

            const invocation = {
                id,
                displayName,
                name,
                parameters: stringify(parameters),
                result: toolResult,
                error: false,
                signature: toolCall.signature || null,
                reasoning: reasoningText || null,
            };
            result.invocations.push(invocation);
        }

        return result;
    }

    /**
     * Groups tool names by count.
     * @param {string[]} toolNames Tool names
     * @returns {string} Grouped tool names
     */
    static #groupToolNames(toolNames) {
        const toolCounts = toolNames.reduce((acc, name) => {
            acc[name] = (acc[name] || 0) + 1;
            return acc;
        }, {});
        return Object.entries(toolCounts).map(([name, count]) => count > 1 ? `${name} (${count})` : name).join(', ');
    }

    /**
     * Formats a message with tool invocations.
     * @param {ToolInvocation[]} invocations Tool invocations.
     * @returns {string} Formatted message with tool invocations.
     */
    static #formatToolInvocationMessage(invocations) {
        const data = structuredClone(invocations);
        const detailsElement = document.createElement('details');
        const summaryElement = document.createElement('summary');
        const listElement = document.createElement('div');
        listElement.className = 'tool-invocation-list';
        const toolNames = data.map(i => i.displayName || this.getToolDisplayInfo(i.name).displayName || i.name);
        summaryElement.textContent = `Tool calls: ${this.#groupToolNames(toolNames)}`;

        data.forEach((invocation, index) => {
            const displayInfo = this.getToolDisplayInfo(invocation.name);
            const parsedParameters = tryParse(invocation.parameters);
            const parsedResult = tryParse(invocation.result);
            const displayName = invocation.displayName || displayInfo.displayName || invocation.name;
            const card = document.createElement('article');
            card.className = `tool-invocation-card${invocation.error ? ' tool-invocation-card--error' : ''}`;

            const header = document.createElement('div');
            header.className = 'tool-invocation-card-header';

            const title = document.createElement('h4');
            title.textContent = displayName || `Tool Call ${index + 1}`;
            header.append(title);

            if (invocation.error) {
                const status = document.createElement('span');
                status.className = 'tool-invocation-status tool-invocation-status--error';
                status.textContent = 'Error';
                header.append(status);
            }

            card.append(header);

            const metadataEntries = [];
            if (invocation.name && invocation.name !== displayName) {
                metadataEntries.push({ label: 'Technical name', value: invocation.name });
            }

            if (displayInfo.displayMetadata?.type === 'mcp') {
                metadataEntries.push(
                    { label: 'MCP server', value: displayInfo.displayMetadata.serverName },
                    { label: 'MCP tool', value: displayInfo.displayMetadata.toolTitle || displayInfo.displayMetadata.toolName },
                );
            }

            if (isPlainObject(parsedParameters)) {
                const parameterSplit = splitToolDisplayObject(parsedParameters, {
                    labelMap: displayInfo.argumentLabels,
                });
                metadataEntries.push(...parameterSplit.metadata);
                appendToolMetadataRows(card, metadataEntries);
                if (parameterSplit.hasPayload) {
                    appendToolPayloadBlock(card, 'Arguments', parameterSplit.payload);
                }
            } else {
                appendToolMetadataRows(card, metadataEntries);
                if (parsedParameters !== undefined && parsedParameters !== null && parsedParameters !== '') {
                    appendToolPayloadBlock(card, 'Arguments', parsedParameters, typeof parsedParameters === 'string' ? 'text' : 'json');
                }
            }

            if (isPlainObject(parsedResult)) {
                const resultSplit = splitToolDisplayObject(parsedResult, {
                    path: ['Result'],
                });
                appendToolMetadataRows(card, resultSplit.metadata);
                if (resultSplit.hasPayload) {
                    appendToolPayloadBlock(card, 'Result', resultSplit.payload);
                }
            } else if (parsedResult !== undefined && parsedResult !== null && parsedResult !== '') {
                appendToolPayloadBlock(card, 'Result', parsedResult, typeof parsedResult === 'string' ? 'text' : 'json');
            }

            listElement.append(card);
        });

        detailsElement.append(summaryElement, listElement);
        return detailsElement.outerHTML;
    }

    /**
     * Builds a downloadable sandbox URL for a media filepath.
     * @param {string} filepath Sandbox-relative path.
     * @param {string} [workspace]
     * @param {string} [character]
     * @returns {string}
     */
    static #getSandboxMediaUrl(filepath, workspace, character) {
        const params = new URLSearchParams({
            file: String(filepath ?? ''),
            workspace: String(workspace ?? getCurrentSandboxWorkspace() ?? ''),
            character: String(character ?? getCurrentSandboxCharacterName() ?? ''),
        });
        return `/api/extensions/tools/download?${params.toString()}`;
    }

    /**
     * Extracts image media attachments from tool invocation results.
     * @param {ToolInvocation[]} invocations
     * @returns {Array<{ url: string, type: string, title: string, source: string }>}
     */
    static #extractToolInvocationMedia(invocations) {
        const media = [];
        for (const invocation of invocations) {
            const parsed = tryParse(invocation.result);
            if (!parsed || typeof parsed !== 'object') {
                continue;
            }

            const screenshots = [];
            if (parsed.type === 'image_display' && parsed.filepath) {
                screenshots.push(parsed);
            }
            if (parsed.screenshot?.filepath) {
                screenshots.push(parsed.screenshot);
            }
            if (parsed.opened_tab_screenshot?.filepath) {
                screenshots.push(parsed.opened_tab_screenshot);
            }
            if (parsed.downloaded_file?.filepath) {
                screenshots.push(parsed.downloaded_file);
            }

            for (const screenshot of screenshots) {
                const url = this.#getSandboxMediaUrl(screenshot.filepath, screenshot.workspace, screenshot.character);
                media.push({
                    url,
                    type: 'image',
                    title: screenshot.filepath,
                    source: 'api',
                });
            }
        }
        return media;
    }

    /**
     * Saves function tool invocations to the last user chat message extra metadata.
     * @param {ToolInvocation[]} invocations Successful tool invocations
     */
    static async saveFunctionToolInvocations(invocations) {
        if (!Array.isArray(invocations) || invocations.length === 0) {
            return;
        }
        const message = {
            name: systemUserName,
            force_avatar: system_avatar,
            is_system: true,
            is_user: false,
            mes: ToolManager.#formatToolInvocationMessage(invocations),
            extra: {
                isSmallSys: true,
                tool_invocations: invocations,
                is_tool_result: true,
                tool_result_role: getConfiguredToolResultRole(),
                media: ToolManager.#extractToolInvocationMedia(invocations),
            },
        };
        chat.push(message);
        await eventSource.emit(event_types.TOOL_CALLS_PERFORMED, invocations);
        addOneMessage(message);
        await eventSource.emit(event_types.TOOL_CALLS_RENDERED, invocations);
        await saveChatConditional();
    }

    /**
     * Shows an error message for tool calls.
     * @param {Error[]} errors Errors that occurred during tool invocation
     * @returns {void}
     */
    static showToolCallError(errors) {
        toastr.error('An error occurred while invoking function tools. Click here for more details.', 'Tool Calling', {
            onclick: () => Popup.show.text('Tool Calling Errors', DOMPurify.sanitize(errors.map(e => `${e.cause}: ${e.message}`).join('<br>'))),
            timeOut: 5000,
        });
    }

    /**
     * Shows a user-facing error for malformed native/XML tool calls.
     * @param {{ message?: string, raw_tool_block?: string, raw_xml?: string } | null | undefined} parseError Parse error info
     * @returns {void}
     */
    static showNativeToolCallParseError(parseError) {
        if (!parseError?.message) {
            return;
        }

        const rawToolBlock = String(parseError.raw_tool_block ?? '').trim();
        const rawXml = String(parseError.raw_xml ?? '').trim();
        const details = [
            '<div style="text-align: left;">',
            `<p style="margin: 0 0 10px 0; line-height: 1.5;">${DOMPurify.sanitize(parseError.message)}</p>`,
            rawToolBlock
                ? `<p style="margin: 6px 0 8px 0;"><strong>Raw tool block</strong></p><pre style="margin: 0 0 14px 0; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; background: rgba(0, 0, 0, 0.28); overflow: auto; white-space: pre-wrap; word-break: break-word; text-align: left;"><code style="display: block; padding: 0; background: transparent; color: inherit; font-family: var(--mainFontFamilyMono, Consolas, Monaco, monospace); font-size: 0.95em; line-height: 1.45; text-decoration: none;">${DOMPurify.sanitize(rawToolBlock)}</code></pre>`
                : '',
            rawXml
                ? `<p style="margin: 6px 0 8px 0;"><strong>Detected XML</strong></p><pre style="margin: 0 0 14px 0; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; background: rgba(0, 0, 0, 0.28); overflow: auto; white-space: pre-wrap; word-break: break-word; text-align: left;"><code style="display: block; padding: 0; background: transparent; color: inherit; font-family: var(--mainFontFamilyMono, Consolas, Monaco, monospace); font-size: 0.95em; line-height: 1.45; text-decoration: none;">${DOMPurify.sanitize(rawXml)}</code></pre>`
                : '',
            '</div>',
        ].filter(Boolean).join('');

        toastr.error('The model produced an invalid tool call. Click here for details.', 'Tool Calling', {
            onclick: () => Popup.show.text('Invalid Tool Call', details, {
                leftAlign: true,
                wider: true,
                allowVerticalScrolling: true,
            }),
            timeOut: 7000,
            preventDuplicates: true,
        });
    }

    static initToolSlashCommands() {
        return this.registerNativeToolCommand();
    }

    static unregisterNativeToolCommand() {
        this.#tools.clear();
        SlashCommandParser.removeCommand('tools-list');
        SlashCommandParser.removeCommand('tools-invoke');
        SlashCommandParser.removeCommand('tools-register');
        SlashCommandParser.removeCommand('tools-unregister');
    }

    static registerNativeToolCommand() {
        // First, unregister any existing tool commands to ensure a clean slate.
        this.unregisterNativeToolCommand();

        // Now, register the built-in tools based on current settings
        registerBuiltinTools();
        registerMcpToolsFromCache();

        const toolsEnumProvider = () => ToolManager.tools.map(tool => {
            const toolOpenAI = tool.toFunctionOpenAI();
            return new SlashCommandEnumValue(toolOpenAI.function.name, toolOpenAI.function.description, enumTypes.enum, enumIcons.closure);
        });

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'tools-list',
            aliases: ['tool-list'],
            helpString: 'Gets a list of all registered tools in the OpenAI function JSON format. Use the <code>return</code> argument to specify the return value type.',
            returns: 'A list of all registered tools.',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'return',
                    description: 'The way how you want the return value to be provided',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: 'none',
                    enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                    forceEnum: true,
                }),
            ],
            callback: async (args) => {
                /** @type {any} */
                const returnType = String(args?.return ?? 'popup-html').trim().toLowerCase();
                const objectToStringFunc = (tools) => Array.isArray(tools) ? tools.map(x => x.toString()).join('\n\n') : tools.toString();
                const tools = ToolManager.tools.map(tool => tool.toFunctionOpenAI());
                return await slashCommandReturnHelper.doReturn(returnType ?? 'popup-html', tools ?? [], { objectToStringFunc });
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'tools-invoke',
            aliases: ['tool-invoke'],
            helpString: 'Invokes a registered tool by name. The <code>parameters</code> argument MUST be a JSON-serialized object.',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'parameters',
                    description: 'The parameters to pass to the tool.',
                    typeList: [ARGUMENT_TYPE.DICTIONARY],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'The name of the tool to invoke.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    acceptsMultiple: false,
                    forceEnum: true,
                    enumProvider: toolsEnumProvider,
                }),
            ],
            callback: async (args, name) => {
                const { parameters } = args;

                const result = await ToolManager.invokeFunctionTool(String(name), parameters);
                if (result instanceof Error) {
                    throw result;
                }

                return result;
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'tools-register',
            aliases: ['tool-register'],
            helpString: `<div>Registers a new tool with the tool registry.</div>
                <ul>
                    <li>The <code>parameters</code> argument MUST be a JSON-serialized object with a valid JSON schema.</li>
                    <li>The unnamed argument MUST be a closure that accepts the function parameters as local script variables.</li>
                </ul>
                <div>See <a target="_blank" href="https://json-schema.org/learn/">json-schema.org</a> and <a target="_blank" href="https://platform.openai.com/docs/guides/function-calling">OpenAI Function Calling</a> for more information.</div>
                <div>Example:</div>
                <pre><code>/let key=echoSchema
{
    "$schema": "http://json-schema.org/draft-04/schema#",
    "type": "object",
    "properties": {
        "message": {
            "type": "string",
            "description": "The message to echo."
        }
    },
    "required": [
        "message"
    ]
}
||
/tools-register name=Echo description="Echoes a message. Call when the user is asking to repeat something" parameters={{var::echoSchema}} {: /echo {{var::arg.message}} :}</code></pre>`,
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'name',
                    description: 'The name of the tool.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'description',
                    description: 'A description of what the tool does.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'parameters',
                    description: 'The parameters for the tool.',
                    typeList: [ARGUMENT_TYPE.DICTIONARY],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'displayName',
                    description: 'The display name of the tool.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'formatMessage',
                    description: 'The closure to be executed to format the tool call message. Must return a string.',
                    typeList: [ARGUMENT_TYPE.CLOSURE],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'shouldRegister',
                    description: 'The closure to be executed to determine if the tool should be registered. Must return a boolean.',
                    typeList: [ARGUMENT_TYPE.CLOSURE],
                    isRequired: false,
                    acceptsMultiple: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'stealth',
                    description: 'If true, a tool call result will not be shown in the chat and no follow-up generation will be performed.',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    isRequired: false,
                    acceptsMultiple: false,
                    defaultValue: String(false),
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'The closure to be executed when the tool is invoked.',
                    typeList: [ARGUMENT_TYPE.CLOSURE],
                    isRequired: true,
                    acceptsMultiple: false,
                }),
            ],
            callback: async (args, action) => {
                /**
                 * Converts a slash command closure to a function.
                 * @param {SlashCommandClosure} action Closure to convert to a function
                 * @param {function(any): any} convertResult Function to convert the result
                 * @returns {function} Function that executes the closure
                 */
                function closureToFunction(action, convertResult) {
                    return async (args) => {
                        const localClosure = action.getCopy();
                        localClosure.onProgress = () => { };
                        const scope = localClosure.scope;
                        if (typeof args === 'object' && args !== null) {
                            assignNestedVariables(scope, args, 'arg');
                        } else if (typeof args !== 'undefined') {
                            scope.letVariable('arg', args);
                        }
                        const result = await localClosure.execute();
                        return convertResult(result.pipe);
                    };
                }

                const { name, displayName, description, parameters, formatMessage, shouldRegister, stealth } = args;

                if (!(action instanceof SlashCommandClosure)) {
                    throw new Error('The unnamed argument must be a closure.');
                }
                if (typeof name !== 'string' || !name) {
                    throw new Error('The "name" argument must be a non-empty string.');
                }
                if (typeof description !== 'string' || !description) {
                    throw new Error('The "description" argument must be a non-empty string.');
                }
                if (typeof parameters !== 'string' || !isJson(parameters)) {
                    throw new Error('The "parameters" argument must be a JSON-serialized object.');
                }
                if (displayName && typeof displayName !== 'string') {
                    throw new Error('The "displayName" argument must be a string.');
                }
                if (formatMessage && !(formatMessage instanceof SlashCommandClosure)) {
                    throw new Error('The "formatMessage" argument must be a closure.');
                }
                if (shouldRegister && !(shouldRegister instanceof SlashCommandClosure)) {
                    throw new Error('The "shouldRegister" argument must be a closure.');
                }

                const actionFunc = closureToFunction(action, x => x);
                const formatMessageFunc = formatMessage instanceof SlashCommandClosure ? closureToFunction(formatMessage, x => String(x)) : null;
                const shouldRegisterFunc = shouldRegister instanceof SlashCommandClosure ? closureToFunction(shouldRegister, x => isTrueBoolean(x)) : null;

                ToolManager.registerFunctionTool({
                    name: String(name ?? ''),
                    displayName: String(displayName ?? ''),
                    description: String(description ?? ''),
                    parameters: JSON.parse(parameters ?? '{}'),
                    action: actionFunc,
                    formatMessage: formatMessageFunc,
                    shouldRegister: shouldRegisterFunc,
                    stealth: stealth && isTrueBoolean(String(stealth)),
                });

                return '';
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'tools-unregister',
            aliases: ['tool-unregister'],
            helpString: 'Unregisters a tool from the tool registry.',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'The name of the tool to unregister.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    acceptsMultiple: false,
                    forceEnum: true,
                    enumProvider: toolsEnumProvider,
                }),
            ],
            callback: async (_, name) => {
                if (typeof name !== 'string' || !name) {
                    throw new Error('The unnamed argument must be a non-empty string.');
                }

                ToolManager.unregisterFunctionTool(name);
                return '';
            },
        }));
    }
}

let sandboxWorkspaceSelectorInitialized = false;
let sandboxWorkspaceManageButtonInitialized = false;

function getSandboxWorkspaceSelectElement() {
    const element = document.getElementById('sandbox_workspace_select');
    return element instanceof HTMLSelectElement ? element : null;
}

function getSandboxWorkspaceManageButtonElement() {
    const element = document.getElementById('sandbox_workspace_manage_button');
    return element instanceof HTMLButtonElement ? element : null;
}

function getSandboxWorkspaceRefreshButtonElement() {
    const element = document.getElementById('sandbox_workspace_refresh_button');
    return element instanceof HTMLButtonElement ? element : null;
}

function getSandboxWorkspaceAddButtonElement() {
    const element = document.getElementById('sandbox_workspace_add_button');
    return element instanceof HTMLButtonElement ? element : null;
}

function getSandboxLocationLabelElement() {
    const element = document.getElementById('sandbox_location_label');
    return element instanceof HTMLElement ? element : null;
}

function updateSandboxLocationLabel() {
    const locationElement = getSandboxLocationLabelElement();
    if (!locationElement) {
        return;
    }

    const basePath = String(sandboxRootPath || '').trim() || 'sandbox';
    locationElement.textContent = `${basePath}\\<workspace>`;
}

async function fetchSandboxWorkspaces() {
    try {
        const response = await fetch('/api/extensions/tools/workspaces', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Failed to load workspaces.' }));
            throw new Error(error.error || 'Failed to load workspaces.');
        }

        const result = await response.json();
        sandboxRootPath = String(result.rootPath || '').trim();
        updateSandboxLocationLabel();
        return Array.isArray(result.workspaces) ? result.workspaces : [];
    } catch (error) {
        console.error('Failed to fetch sandbox workspaces:', error);
        toastr.error(`Failed to fetch sandbox workspaces: ${error.message}`);
        return [];
    }
}

async function createSandboxWorkspace(workspace) {
    try {
        const response = await fetch('/api/extensions/tools/listdir', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: '.', workspace }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Failed to create workspace.' }));
            throw new Error(error.error || 'Failed to create workspace.');
        }

        return true;
    } catch (error) {
        console.error('Failed to create workspace:', error);
        toastr.error(`Failed to create workspace: ${error.message}`);
        return false;
    }
}

/**
 * @param {unknown} workspace
 * @returns {string}
 */
function setSandboxWorkspaceForCurrentChat(workspace) {
    const normalizedWorkspace = String(workspace || '').trim() || SANDBOX_ROOT_WORKSPACE;
    chat_metadata.sandbox_workspace = normalizedWorkspace;
    return normalizedWorkspace;
}

/**
 * @param {unknown} workspace
 * @returns {Promise<string>}
 */
async function persistSandboxWorkspaceForCurrentChat(workspace) {
    const normalizedWorkspace = setSandboxWorkspaceForCurrentChat(workspace);
    await saveChatConditional();
    return normalizedWorkspace;
}

/**
 * @param {string} dirPath
 * @param {string} workspace
 * @param {string} character
 * @returns {Promise<{directories: string[], files: string[]}>}
 */
async function listSandboxDirectory(dirPath, workspace, character) {
    const response = await fetch('/api/extensions/tools/listdir', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: dirPath, workspace, character }),
    });

    const result = await response.json().catch(() => ({ error: 'Failed to list directory.' }));
    if (!response.ok) {
        throw new Error(result.error || 'Failed to list directory.');
    }

    return {
        directories: Array.isArray(result.directories) ? result.directories : [],
        files: Array.isArray(result.files) ? result.files : [],
    };
}

/**
 * @param {string} filepath
 * @param {string} filename
 * @param {string} workspace
 */
function downloadSandboxFile(filepath, filename, workspace) {
    const params = new URLSearchParams({
        file: filepath,
        workspace: workspace || getCurrentSandboxWorkspace() || SANDBOX_ROOT_WORKSPACE,
        character: getCurrentSandboxCharacterName() || '',
        download: 'true',
    });
    const url = `/api/extensions/tools/download?${params.toString()}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

/**
 * @param {string} filepath
 * @returns {boolean}
 */
function isSandboxImageFile(filepath) {
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
    const ext = filepath.split('.').pop()?.toLowerCase() || '';
    return imageExts.includes(ext);
}

/**
 * @param {string} pathValue
 * @returns {string}
 */
function normalizeSandboxRelativePath(pathValue) {
    const raw = String(pathValue || '').trim().replace(/\\/g, '/');
    if (!raw || raw === '.' || raw === '/') {
        return '.';
    }

    const segments = [];
    for (const segment of raw.split('/')) {
        const part = segment.trim();
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            segments.pop();
            continue;
        }
        segments.push(part);
    }

    return segments.length > 0 ? segments.join('/') : '.';
}

/**
 * @param {string} basePath
 * @param {string} childPath
 * @returns {string}
 */
function joinSandboxRelativePath(basePath, childPath) {
    const normalizedBase = normalizeSandboxRelativePath(basePath);
    const normalizedChild = normalizeSandboxRelativePath(childPath);
    if (normalizedChild === '.') {
        return normalizedBase;
    }

    if (normalizedBase === '.') {
        return normalizedChild;
    }

    return normalizeSandboxRelativePath(`${normalizedBase}/${normalizedChild}`);
}

/**
 * @param {string} pathValue
 * @returns {string}
 */
function getSandboxRelativeParentPath(pathValue) {
    const normalized = normalizeSandboxRelativePath(pathValue);
    if (normalized === '.') {
        return '.';
    }

    const parts = normalized.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') : '.';
}

/**
 * @param {string} pathValue
 * @returns {string[]}
 */
function getSandboxRelativePathSegments(pathValue) {
    const normalized = normalizeSandboxRelativePath(pathValue);
    return normalized === '.' ? [] : normalized.split('/');
}

/**
 * @param {string} pathValue
 * @returns {string}
 */
function formatSandboxPathLabel(pathValue) {
    const normalized = normalizeSandboxRelativePath(pathValue);
    return normalized === '.' ? 'uploads' : normalized;
}

/**
 * @param {string} iconClass
 * @param {string} label
 * @param {string} title
 * @param {string} [extraClass='']
 * @returns {HTMLButtonElement}
 */
function createSandboxManagerButton(iconClass, label, title, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${extraClass}`.trim();

    if (title) {
        button.title = title;
    }

    if (iconClass) {
        const icon = document.createElement('i');
        icon.className = `fa-solid ${iconClass}`;
        button.append(icon);
    }

    if (label) {
        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        button.append(labelSpan);
    }

    return button;
}

function createMcpPopupSubheader(title, subtitle = '') {
    const header = document.createElement('div');
    header.className = 'mcp-popup-subheader';

    const main = document.createElement('div');
    main.className = 'mcp-popup-subheader-main';

    const strong = document.createElement('strong');
    strong.textContent = title;
    main.append(strong);
    header.append(main);

    if (subtitle) {
        const small = document.createElement('small');
        small.className = 'mcp-card-subtitle';
        small.textContent = subtitle;
        header.append(small);
    }
    return header;
}

function createMcpPopupHeaderActions(actions = []) {
    const wrap = document.createElement('div');
    wrap.className = 'mcp-popup-header-actions';
    for (const action of actions) {
        if (action instanceof HTMLElement) {
            wrap.append(action);
        }
    }
    return wrap;
}

function addMcpPopupCloseButton(popup, header) {
    if (!(header instanceof HTMLElement) || header.querySelector('.mcp-popup-close')) {
        return;
    }

    const target = header.querySelector('.mcp-popup-subheader-main, .mcp-manager-actions, .mcp-config-popup-links') instanceof HTMLElement
        ? header.querySelector('.mcp-popup-subheader-main, .mcp-manager-actions, .mcp-config-popup-links')
        : header;

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'menu_button menu_button_icon mcp-popup-close';
    closeButton.title = 'Close';
    closeButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeButton.addEventListener('click', () => {
        void popup.completeCancelled();
    });
    target.append(closeButton);
}

/**
 * @param {'folder'|'file'} kind
 * @param {string} name
 * @param {string} pathValue
 * @param {string} subtitle
 * @param {string} iconClass
 * @param {string} actionLabel
 * @param {string} actionIconClass
 * @param {() => void} onAction
 * @returns {HTMLElement}
 */
function createSandboxManagerItem(kind, name, pathValue, subtitle, iconClass, actionLabel, actionIconClass, onAction) {
    const item = document.createElement('div');
    item.className = `sandbox-manager-item sandbox-manager-item--${kind}`;
    item.dataset.path = pathValue;
    item.dataset.kind = kind;

    if (kind === 'folder') {
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.addEventListener('click', onAction);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onAction();
            }
        });
    }

    const iconWrap = document.createElement('span');
    iconWrap.className = 'sandbox-manager-item-icon';
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;
    iconWrap.append(icon);

    const body = document.createElement('span');
    body.className = 'sandbox-manager-item-body';

    const title = document.createElement('span');
    title.className = 'sandbox-manager-item-title';
    title.textContent = name;

    const meta = document.createElement('span');
    meta.className = 'sandbox-manager-item-meta';
    meta.textContent = subtitle;

    body.append(title, meta);

    const actions = document.createElement('span');
    actions.className = 'sandbox-manager-item-actions';

    const actionButton = createSandboxManagerButton(actionIconClass, actionLabel, `${actionLabel} ${name}`, 'menu_button_icon sandbox-manager-item-action');
    actionButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onAction();
    });
    actions.append(actionButton);

    item.append(iconWrap, body, actions);
    return item;
}

/**
 * @returns {string}
 */
function getSandboxManagerPopupContent() {
    return `
        <div class="sandbox-manager-popup">
            <section class="sandbox-manager-panel sandbox-manager-controls">
                <div class="sandbox-manager-toolbar">
                    <div class="sandbox-manager-field sandbox-manager-field--workspace">
                        <label class="sandbox-manager-label" for="sandbox-manager-workspace-select">Workspace</label>
                        <select id="sandbox-manager-workspace-select" class="text_pole sandbox-manager-workspace-select"></select>
                    </div>
                    <div class="sandbox-manager-toolbar-actions">
                        <button type="button" class="menu_button menu_button_icon sandbox-manager-refresh" title="Refresh workspace list">
                            <i class="fa-solid fa-rotate"></i>
                        </button>
                        <button type="button" class="menu_button menu_button_icon sandbox-manager-new" title="Create new workspace">
                            <i class="fa-solid fa-folder-plus"></i>
                        </button>
                    </div>
                </div>
                <div class="sandbox-manager-nav">
                    <div class="sandbox-manager-field">
                        <label class="sandbox-manager-label">Location</label>
                        <div class="sandbox-manager-breadcrumbs" aria-label="Current folder breadcrumbs"></div>
                    </div>
                    <div class="sandbox-manager-pathbar">
                        <input class="text_pole sandbox-manager-path" type="text" value="." placeholder="uploads or subfolder, like prompts/docs">
                        <button type="button" class="menu_button menu_button_icon sandbox-manager-up" title="Go to parent folder">
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button type="button" class="menu_button menu_button_icon sandbox-manager-browse" title="Open the typed path">
                            <i class="fa-solid fa-folder-tree"></i>
                        </button>
                    </div>
                    <div class="sandbox-manager-searchbar">
                        <input class="text_pole sandbox-manager-search" type="search" placeholder="Filter folders and files by name...">
                        <button type="button" class="menu_button menu_button_icon sandbox-manager-clear-search" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
            </section>
            <section class="sandbox-manager-panel sandbox-manager-browser">
                <div class="sandbox-manager-section-header">
                    <div>
                        <span>Folders</span>
                        <small class="sandbox-manager-section-count sandbox-manager-folder-count"></small>
                    </div>
                </div>
                <div class="sandbox-manager-list sandbox-manager-folder-list" aria-label="Folder list"></div>
                <div class="sandbox-manager-section-header">
                    <div>
                        <span>Files</span>
                        <small class="sandbox-manager-section-count sandbox-manager-file-count"></small>
                    </div>
                </div>
                <div class="sandbox-manager-list sandbox-manager-file-list" aria-label="File list"></div>
                <div class="sandbox-manager-empty-state sandbox-manager-empty" hidden></div>
            </section>
            <footer class="sandbox-manager-footer">
                <small class="sandbox-manager-status" aria-live="polite"></small>
                <small class="sandbox-manager-summary"></small>
            </footer>
        </div>
    `;
}

async function openSandboxManagerPopup() {
    let selectedWorkspace = getCurrentSandboxWorkspace() || SANDBOX_ROOT_WORKSPACE;
    let currentPath = '.';

    const popupOptions = {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Close',
        onOpen: async (popup) => {
            const workspaceSelect = popup.dlg.querySelector('.sandbox-manager-workspace-select');
            const refreshButton = popup.dlg.querySelector('.sandbox-manager-refresh');
            const newButton = popup.dlg.querySelector('.sandbox-manager-new');
            const pathInput = popup.dlg.querySelector('.sandbox-manager-path');
            const browseButton = popup.dlg.querySelector('.sandbox-manager-browse');
            const upButton = popup.dlg.querySelector('.sandbox-manager-up');
            const clearSearchButton = popup.dlg.querySelector('.sandbox-manager-clear-search');
            const searchInput = popup.dlg.querySelector('.sandbox-manager-search');
            const breadcrumbs = popup.dlg.querySelector('.sandbox-manager-breadcrumbs');
            const statusElement = popup.dlg.querySelector('.sandbox-manager-status');
            const summaryElement = popup.dlg.querySelector('.sandbox-manager-summary');
            const folderCountElement = popup.dlg.querySelector('.sandbox-manager-folder-count');
            const fileCountElement = popup.dlg.querySelector('.sandbox-manager-file-count');
            const emptyStateElement = popup.dlg.querySelector('.sandbox-manager-empty');
            const folderList = popup.dlg.querySelector('.sandbox-manager-folder-list');
            const fileList = popup.dlg.querySelector('.sandbox-manager-file-list');

            if (!workspaceSelect || !refreshButton || !newButton || !pathInput || !browseButton || !upButton || !clearSearchButton || !searchInput || !breadcrumbs || !statusElement || !summaryElement || !folderCountElement || !fileCountElement || !emptyStateElement || !folderList || !fileList) {
                return;
            }

            let currentListing = { directories: [], files: [] };

            const setStatus = (text, state = 'info') => {
                statusElement.textContent = text;
                statusElement.dataset.state = state;
            };

            const clearStatus = () => {
                setStatus('', 'info');
            };

            const setButtonBusy = (button, isBusy) => {
                button.disabled = isBusy;
                button.classList.toggle('disabled', isBusy);
            };

            const updateHeader = () => {
                upButton.disabled = normalizeSandboxRelativePath(currentPath) === '.';
                clearSearchButton.disabled = !String(searchInput.value || '').trim();
            };

            const renderBreadcrumbs = () => {
                breadcrumbs.replaceChildren();
                const normalizedPath = normalizeSandboxRelativePath(currentPath);
                const segments = getSandboxRelativePathSegments(normalizedPath);

                const rootButton = createSandboxManagerButton('fa-house', 'uploads', 'Go to uploads folder', 'sandbox-manager-breadcrumb-button');
                rootButton.dataset.path = '.';
                rootButton.addEventListener('click', async () => {
                    pathInput.value = '.';
                    await browseDirectory('.');
                });
                breadcrumbs.append(rootButton);

                let accumulated = [];
                for (const segment of segments) {
                    const separator = document.createElement('span');
                    separator.className = 'sandbox-manager-breadcrumb-separator';
                    separator.textContent = '/';
                    breadcrumbs.append(separator);

                    accumulated = [...accumulated, segment];
                    const pathValue = accumulated.join('/');
                    const crumb = createSandboxManagerButton('', segment, `Go to ${pathValue}`, 'sandbox-manager-breadcrumb-button sandbox-manager-breadcrumb-chip');
                    crumb.dataset.path = pathValue;
                    crumb.addEventListener('click', async () => {
                        pathInput.value = pathValue;
                        await browseDirectory(pathValue);
                    });
                    breadcrumbs.append(crumb);
                }
            };

            const renderList = () => {
                const searchTerm = String(searchInput.value || '').toLowerCase().trim();
                const directories = [...currentListing.directories].sort((a, b) => a.localeCompare(b));
                const files = [...currentListing.files].sort((a, b) => a.localeCompare(b));
                const filteredDirectories = searchTerm ? directories.filter(entry => entry.toLowerCase().includes(searchTerm)) : directories;
                const filteredFiles = searchTerm ? files.filter(entry => entry.toLowerCase().includes(searchTerm)) : files;
                const totalItems = directories.length + files.length;
                const visibleItems = filteredDirectories.length + filteredFiles.length;

                folderList.replaceChildren();
                fileList.replaceChildren();

                folderCountElement.textContent = `${filteredDirectories.length} item${filteredDirectories.length === 1 ? '' : 's'}`;
                fileCountElement.textContent = `${filteredFiles.length} item${filteredFiles.length === 1 ? '' : 's'}`;

                if (searchTerm && visibleItems === 0 && totalItems > 0) {
                    emptyStateElement.hidden = false;
                    emptyStateElement.textContent = `No matches found for "${searchInput.value.trim()}".`;
                    summaryElement.textContent = `${totalItems} total items in this folder`;
                    return;
                }

                if (visibleItems === 0) {
                    emptyStateElement.hidden = false;
                    emptyStateElement.textContent = 'This folder is empty.';
                    summaryElement.textContent = '0 items';
                    return;
                }

                emptyStateElement.hidden = true;
                summaryElement.textContent = searchTerm
                    ? `Showing ${visibleItems} of ${totalItems} items`
                    : `${totalItems} item${totalItems === 1 ? '' : 's'} total`;

                for (const directory of filteredDirectories) {
                    const directoryPath = joinSandboxRelativePath(currentPath, directory);
                    const item = createSandboxManagerItem(
                        'folder',
                        directory,
                        directoryPath,
                        `Folder in ${formatSandboxPathLabel(currentPath)}`,
                        'fa-folder',
                        'Open',
                        'fa-arrow-right',
                        () => {
                            pathInput.value = directoryPath;
                            void browseDirectory(directoryPath);
                        },
                    );
                    folderList.append(item);
                }

                for (const file of filteredFiles) {
                    const filePath = joinSandboxRelativePath(currentPath, file);
                    const isImage = isSandboxImageFile(file);
                    const item = createSandboxManagerItem(
                        'file',
                        file,
                        filePath,
                        isImage ? 'Image file' : 'File',
                        isImage ? 'fa-image' : 'fa-file',
                        'Download',
                        'fa-download',
                        () => {
                            downloadSandboxFile(filePath, file, selectedWorkspace);
                            setStatus(`Downloaded "${file}".`, 'success');
                        },
                    );
                    fileList.append(item);
                }
            };

            const syncDirectoryUi = () => {
                pathInput.value = currentPath;
                renderBreadcrumbs();
                updateHeader();
                renderList();
            };

            const refreshWorkspaces = async () => {
                setButtonBusy(refreshButton, true);
                try {
                    const workspaceNames = await fetchSandboxWorkspaces();
                    const uniqueWorkspaces = [...new Set(workspaceNames.map(x => String(x || '').trim()).filter(Boolean))]
                        .sort((a, b) => a.localeCompare(b));

                    if (selectedWorkspace !== SANDBOX_ROOT_WORKSPACE && !uniqueWorkspaces.includes(selectedWorkspace)) {
                        uniqueWorkspaces.unshift(selectedWorkspace);
                    }

                    workspaceSelect.innerHTML = '';
                    const rootOption = document.createElement('option');
                    rootOption.value = SANDBOX_ROOT_WORKSPACE;
                    rootOption.textContent = 'uploads';
                    workspaceSelect.append(rootOption);

                    for (const workspace of uniqueWorkspaces) {
                        if (workspace === SANDBOX_ROOT_WORKSPACE) continue;
                        const option = document.createElement('option');
                        option.value = workspace;
                        option.textContent = workspace;
                        workspaceSelect.append(option);
                    }

                    workspaceSelect.value = selectedWorkspace;
                    workspaceSelect.disabled = false;
                    newButton.disabled = false;
                    updateHeader();
                } finally {
                    setButtonBusy(refreshButton, false);
                }
            };

            const persistWorkspace = async () => {
                selectedWorkspace = await persistSandboxWorkspaceForCurrentChat(selectedWorkspace);
                await refreshSandboxWorkspaceSelector();
            };

            const browseDirectory = async (targetPath = currentPath) => {
                currentPath = normalizeSandboxRelativePath(targetPath);
                pathInput.value = currentPath;
                updateHeader();
                clearStatus();
                setButtonBusy(browseButton, true);

                try {
                    const listing = await listSandboxDirectory(currentPath, selectedWorkspace, getCurrentSandboxCharacterName());
                    currentListing = listing;
                    syncDirectoryUi();
                } catch (error) {
                    currentListing = { directories: [], files: [] };
                    folderList.replaceChildren();
                    fileList.replaceChildren();
                    emptyStateElement.hidden = false;
                    emptyStateElement.textContent = `Unable to open "${formatSandboxPathLabel(currentPath)}".`;
                    summaryElement.textContent = '0 items';
                    setStatus(String(error?.message || error), 'error');
                } finally {
                    setButtonBusy(browseButton, false);
                    updateHeader();
                }
            };

            workspaceSelect.addEventListener('change', async () => {
                selectedWorkspace = String(workspaceSelect.value || '').trim() || SANDBOX_ROOT_WORKSPACE;
                await persistWorkspace();
                currentPath = '.';
                await browseDirectory('.');
            });

            refreshButton.addEventListener('click', async () => {
                await refreshWorkspaces();
                setStatus('Workspace list refreshed.', 'success');
            });

            newButton.addEventListener('click', async () => {
                const input = await Popup.show.input('New Workspace', 'Enter workspace name:');
                if (!input) {
                    return;
                }

                const sanitized = await getSanitizedFilename(String(input));
                const workspace = String(sanitized || '').trim();
                if (!workspace) {
                    toastr.warning('Workspace name cannot be empty.');
                    return;
                }

                const created = await createSandboxWorkspace(workspace);
                if (!created) {
                    return;
                }

                selectedWorkspace = workspace;
                await persistWorkspace();
                await refreshWorkspaces();
                currentPath = '.';
                await browseDirectory('.');
                setStatus(`Created workspace "${workspace}".`, 'success');
            });

            browseButton.addEventListener('click', async () => {
                await browseDirectory(pathInput.value || '.');
            });

            upButton.addEventListener('click', async () => {
                await browseDirectory(getSandboxRelativeParentPath(currentPath));
            });

            clearSearchButton.addEventListener('click', () => {
                searchInput.value = '';
                renderList();
                updateHeader();
                searchInput.focus();
            });

            pathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    void browseDirectory(pathInput.value || '.');
                }
            });

            searchInput.addEventListener('input', () => {
                renderList();
                updateHeader();
            });

            await refreshWorkspaces();
            clearStatus();
            await browseDirectory('.');
        },
    };

    await Popup.show.text('Sandbox Manager', getSandboxManagerPopupContent(), popupOptions);
}

function getMcpManagerPopupContent() {
    return `
        <div class="mcp-manager-popup">
            <section class="mcp-manager-header">
                <div class="mcp-manager-header-main">
                    <div class="mcp-manager-brand" aria-hidden="true">
                        <i class="fa-solid fa-database"></i>
                    </div>
                    <div class="mcp-manager-heading">
                        <strong>MCP Manager</strong>
                        <small class="mcp-manager-status"></small>
                    </div>
                </div>
                <div class="mcp-manager-actions">
                    <button type="button" class="menu_button mcp-manager-add">Add Server</button>
                    <button type="button" class="menu_button menu_button_icon mcp-manager-refresh-all" title="Refresh enabled MCP servers">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                </div>
            </section>
            <section class="mcp-manager-servers">
                <div class="mcp-manager-searchbar">
                    <input class="text_pole mcp-manager-search" type="search" placeholder="Search servers...">
                </div>
                <div class="mcp-manager-section-header">
                    <strong>All Servers</strong>
                </div>
                <div class="mcp-manager-server-list"></div>
            </section>
            <section class="mcp-manager-selection">
                <div class="mcp-manager-selection-header">
                    <strong class="mcp-manager-selection-title">Enabled in Workspace</strong>
                    <small class="mcp-manager-context-status"></small>
                </div>
                <div class="mcp-manager-context-list"></div>
            </section>
        </div>
    `;
}

function renderMcpSelectedContext(container, onChanged = null) {
    const enabledServers = getMcpServers().filter(server => server.enabled);
    container.replaceChildren();

    if (enabledServers.length === 0) {
        const empty = document.createElement('small');
        empty.className = 'mcp-empty-state';
        empty.textContent = 'No servers enabled for this workspace.';
        container.append(empty);
        return;
    }

    const chips = document.createElement('div');
    chips.className = 'mcp-context-chip-list';

    for (const server of enabledServers) {
        const chip = document.createElement('div');
        chip.className = 'mcp-context-chip';
        chip.title = server.name || server.id;

        const label = document.createElement('span');
        label.className = 'mcp-context-chip-label';
        label.textContent = server.name || server.id;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'menu_button menu_button_icon mcp-context-chip-remove';
        removeButton.title = 'Disable for this workspace';
        removeButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeButton.addEventListener('click', async () => {
            setMcpServerEnabledForWorkspace(server.id, false);
            if (mcpServerStatus.get(server.id)?.connected) {
                await disconnectMcpServer(server);
            } else {
                clearMcpToolsForServer(server.id);
                removeMcpStatus(server.id);
                syncToolRegistryAfterMcpChange();
                refreshMcpSummaryUi();
            }
            if (typeof onChanged === 'function') {
                onChanged();
            } else {
                renderMcpSelectedContext(container);
            }
        });
        chip.append(label, removeButton);
        chips.append(chip);
    }

    container.append(chips);
}

async function openMcpResourcePicker(server) {
    const listing = await callMcpApi('/api/extensions/tools/mcp/resources/list', {
        serverId: server.id,
        ...getSandboxRequestContext(),
    });
    const resources = [
        ...(Array.isArray(listing.resources) ? listing.resources : []),
        ...(Array.isArray(listing.resourceTemplates) ? listing.resourceTemplates : []),
    ];

    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn';
    content.style.gap = '10px';
    content.append(createMcpPopupSubheader('Select Resources'));

    const list = document.createElement('div');
    list.className = 'flex-container flexFlowColumn';
    list.style.gap = '8px';
    content.append(list);

    const render = () => {
        const state = getChatMcpState();
        list.replaceChildren();

        if (resources.length === 0) {
            const empty = document.createElement('small');
            empty.className = 'mcp-empty-state';
            empty.textContent = 'This server did not report any resources.';
            list.append(empty);
            return;
        }

        for (const resource of resources) {
            const selected = state.selectedResources.some(item => item.serverId === server.id && item.uri === resource.uri);
            const row = document.createElement('div');
            row.className = 'flex-container alignitemscenter justifySpaceBetween';
            row.style.gap = '8px';
            row.style.padding = '10px';
            row.style.border = '1px solid rgba(255, 255, 255, 0.12)';
            row.style.borderRadius = '6px';

            const textWrap = document.createElement('div');
            textWrap.className = 'flex-container flexFlowColumn';
            textWrap.style.gap = '2px';

            const title = document.createElement('strong');
            title.textContent = resource.title || resource.name || resource.uri;
            const subtitle = document.createElement('small');
            subtitle.className = 'opacity70p';
            subtitle.textContent = resource.uri;
            textWrap.append(title, subtitle);

            const action = createSandboxManagerButton(selected ? 'fa-check' : 'fa-plus', selected ? 'Selected' : 'Select', selected ? 'Already selected' : 'Select resource', 'menu_button_icon');
            action.disabled = selected;
            action.addEventListener('click', async () => {
                await addSelectedMcpResource(server, resource);
                render();
            });

            row.append(textWrap, action);
            list.append(row);
        }
    };

    render();
    const popup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    }), 'mcp-popup--selection-list');
    await popup.show();
}

async function openMcpPromptPicker(server) {
    const listing = await callMcpApi('/api/extensions/tools/mcp/prompts/list', {
        serverId: server.id,
        ...getSandboxRequestContext(),
    });
    const prompts = Array.isArray(listing.prompts) ? listing.prompts : [];

    const content = document.createElement('div');
    content.className = 'flex-container flexFlowColumn';
    content.style.gap = '10px';
    content.append(createMcpPopupSubheader('Select Prompts'));

    const list = document.createElement('div');
    list.className = 'flex-container flexFlowColumn';
    list.style.gap = '8px';
    content.append(list);

    const render = () => {
        list.replaceChildren();

        if (prompts.length === 0) {
            const empty = document.createElement('small');
            empty.className = 'mcp-empty-state';
            empty.textContent = 'This server did not report any prompts.';
            list.append(empty);
            return;
        }

        for (const prompt of prompts) {
            const row = document.createElement('div');
            row.className = 'flex-container alignitemscenter justifySpaceBetween';
            row.style.gap = '8px';
            row.style.padding = '10px';
            row.style.border = '1px solid rgba(255, 255, 255, 0.12)';
            row.style.borderRadius = '6px';

            const textWrap = document.createElement('div');
            textWrap.className = 'flex-container flexFlowColumn';
            textWrap.style.gap = '2px';

            const title = document.createElement('strong');
            title.textContent = prompt.title || prompt.name;
            const subtitle = document.createElement('small');
            subtitle.className = 'opacity70p';
            subtitle.textContent = prompt.description || prompt.name;
            textWrap.append(title, subtitle);

            const action = createSandboxManagerButton('fa-plus', 'Select', 'Select prompt output', 'menu_button_icon');
            action.addEventListener('click', async () => {
                const promptArguments = await promptForMcpPromptArguments(prompt);
                if (promptArguments === null) {
                    return;
                }

                await addSelectedMcpPrompt(server, prompt, promptArguments);
            });

            row.append(textWrap, action);
            list.append(row);
        }
    };

    render();
    const popup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    }), 'mcp-popup--selection-list');
    await popup.show();
}

function applyMcpPopupClasses(popup, ...classes) {
    popup.dlg.classList.add('mcp-popup', ...classes.filter(Boolean));
    const header = popup.dlg.querySelector('.mcp-manager-header, .mcp-config-popup-header, .mcp-registry-details-header, .mcp-popup-subheader');
    addMcpPopupCloseButton(popup, header);
    return popup;
}

async function testMcpServerConnection(server) {
    const testServer = normalizeMcpServerConfig({
        ...server,
        id: `${server.id || createClientUuid()}__test`,
    });

    try {
        const { snapshot } = await probeMcpServer(testServer, { reconnect: true });
        return {
            connected: snapshot.connected === true,
            toolCount: Array.isArray(snapshot.tools) ? snapshot.tools.length : 0,
            resourceCount: (Array.isArray(snapshot.resources) ? snapshot.resources.length : 0) + (Array.isArray(snapshot.resourceTemplates) ? snapshot.resourceTemplates.length : 0),
            promptCount: Array.isArray(snapshot.prompts) ? snapshot.prompts.length : 0,
            stderr: String(snapshot.stderr || '').trim(),
        };
    } finally {
        try {
            await callMcpApi('/api/extensions/tools/mcp/disconnect', {
                serverId: testServer.id,
                ...getSandboxRequestContext(),
            });
        } catch {
            // Ignore cleanup errors for temporary test connections.
        }
    }
}

async function editMcpServerConfig(existingServer = null, forcedTransportType = null) {
    const draft = normalizeMcpServerConfig(existingServer ?? {
        transportType: forcedTransportType || 'http',
    });

    const transportBadgeLabel = draft.transportType === 'stdio'
        ? 'stdio'
        : draft.transportType === 'sse'
            ? 'SSE'
            : 'Streamable HTTP';

    const form = document.createElement('div');
    form.className = 'mcp-config-popup';
    form.innerHTML = `
        <div class="mcp-config-popup-header">
            <div class="mcp-config-popup-identity">
                ${createMcpIcon(draft.iconUrl, draft.name || 'MCP').outerHTML}
                <div class="mcp-config-popup-copy">
                    <strong>${DOMPurify.sanitize(draft.name || 'MCP Server')}</strong>
                    ${draft.description ? `<small class="mcp-card-subtitle">${DOMPurify.sanitize(draft.description)}</small>` : ''}
                    <div class="mcp-card-badges mcp-config-popup-meta">
                        ${createMcpBadge(draft.transportType === 'stdio' ? 'Local' : 'Remote').outerHTML}
                        ${createMcpBadge(transportBadgeLabel).outerHTML}
                        ${draft.version ? createMcpBadge(`v${draft.version}`).outerHTML : ''}
                        ${(draft.authRequired || draft.authType === 'oauth' || /^\s*authorization:/i.test(draft.headersText)) ? createMcpBadge('Needs auth', 'warning').outerHTML : ''}
                    </div>
                </div>
            </div>
            <div class="mcp-config-popup-links">
                ${draft.websiteUrl ? createMcpActionLink(draft.websiteUrl, 'Website').outerHTML : ''}
                ${draft.repositoryUrl ? createMcpActionLink(draft.repositoryUrl, 'Source').outerHTML : ''}
                ${draft.docsUrl ? createMcpActionLink(draft.docsUrl, 'Docs').outerHTML : ''}
            </div>
        </div>
        <div class="mcp-config-shell">
            <aside class="mcp-config-sidebar">
                <button type="button" class="menu_button mcp-config-nav-button is-active" data-target="configuration">Configuration</button>
                <button type="button" class="menu_button mcp-config-nav-button" data-target="authentication">Authentication</button>
                <button type="button" class="menu_button mcp-config-nav-button" data-target="server-info">Server Info</button>
            </aside>
            <div class="mcp-config-main">
                <section class="mcp-config-panel mcp-config-section-card" data-section="configuration">
                    <div class="mcp-config-panel-heading">
                        <div class="mcp-config-section-title">Configuration</div>
                        <small class="mcp-card-subtitle">Configure how SillyTavern connects to this MCP server.</small>
                    </div>
                    <div class="mcp-config-form-grid mcp-config-form-grid--compact">
                        <label class="mcp-form-field">
                            <small>Name</small>
                            <input class="text_pole mcp-form-name" type="text" value="${DOMPurify.sanitize(draft.name)}" placeholder="Filesystem, Docs, Browser">
                        </label>
                        <label class="mcp-form-field">
                            <small>Transport</small>
                            <select class="text_pole mcp-form-transport">
                                <option value="http">Streamable HTTP</option>
                                <option value="sse">SSE</option>
                                <option value="stdio">Stdio</option>
                            </select>
                        </label>
                    </div>
                    <div class="mcp-form-http mcp-form-section">
                        <div class="mcp-config-section">
                            <div class="mcp-config-section-title">Remote endpoint</div>
                            <div class="mcp-config-form-grid">
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>URL</small>
                                    <input class="text_pole mcp-form-url" type="text" value="${DOMPurify.sanitize(draft.url)}" placeholder="https://example.com/mcp">
                                </label>
                            </div>
                        </div>
                    </div>
                    <div class="mcp-form-stdio mcp-form-section">
                        <div class="mcp-config-section">
                            <div class="mcp-config-section-title">Local command</div>
                            <div class="mcp-config-form-grid">
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Command</small>
                                    <input class="text_pole mcp-form-command" type="text" value="${DOMPurify.sanitize(draft.command)}" placeholder="npx">
                                </label>
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Arguments</small>
                                    <textarea class="text_pole mcp-form-args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;.">${DOMPurify.sanitize(draft.argsText)}</textarea>
                                </label>
                                <label class="mcp-form-field">
                                    <small>Working directory</small>
                                    <input class="text_pole mcp-form-cwd" type="text" value="${DOMPurify.sanitize(draft.cwd)}" placeholder="Optional">
                                </label>
                            </div>
                        </div>
                    </div>
                    <div class="mcp-config-section">
                        <div class="mcp-config-section-title">Options</div>
                        <div class="mcp-config-form-grid mcp-config-form-grid--compact">
                            <label class="mcp-form-field">
                                <small>Timeout (ms)</small>
                                <input class="text_pole mcp-form-timeout" type="number" min="1000" max="180000" step="1000" value="${draft.timeoutMs}">
                            </label>
                            <label class="checkbox_label mcp-form-toggle">
                                <input class="mcp-form-enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}>
                                <small>Enabled</small>
                            </label>
                        </div>
                    </div>
                </section>
                <section class="mcp-config-panel mcp-config-section-card" data-section="authentication">
                    <div class="mcp-config-panel-heading">
                        <div class="mcp-config-section-title">Authentication</div>
                        <small class="mcp-card-subtitle">Add auth details, custom headers, or local environment values.</small>
                    </div>
                    <div class="mcp-form-remote-auth mcp-form-section">
                        <div class="mcp-config-section">
                            <div class="mcp-config-form-grid">
                                <label class="mcp-form-field">
                                    <small>Auth</small>
                                    <select class="text_pole mcp-form-auth">
                                        <option value="none">None or custom headers</option>
                                        <option value="oauth">OAuth 2.1</option>
                                    </select>
                                </label>
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Headers</small>
                                    <textarea class="text_pole mcp-form-headers" rows="3" placeholder="Authorization: Bearer ...">${DOMPurify.sanitize(draft.headersText)}</textarea>
                                </label>
                            </div>
                        </div>
                        <div class="mcp-form-oauth mcp-config-section">
                            <div class="mcp-config-section-title">OAuth</div>
                            <div class="mcp-config-form-grid">
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Redirect URL</small>
                                    <input class="text_pole mcp-form-oauth-redirect" type="text" value="${DOMPurify.sanitize(draft.oauth.redirectUrl)}" placeholder="http://localhost:8000/callback">
                                </label>
                                <label class="mcp-form-field">
                                    <small>Client ID</small>
                                    <input class="text_pole mcp-form-oauth-client-id" type="text" value="${DOMPurify.sanitize(draft.oauth.clientId)}" placeholder="Optional">
                                </label>
                                <label class="mcp-form-field">
                                    <small>Client Secret</small>
                                    <input class="text_pole mcp-form-oauth-client-secret" type="password" value="${DOMPurify.sanitize(draft.oauth.clientSecret)}" placeholder="Optional">
                                </label>
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Scopes</small>
                                    <input class="text_pole mcp-form-oauth-scope" type="text" value="${DOMPurify.sanitize(draft.oauth.scope)}" placeholder="Optional space-separated scopes">
                                </label>
                            </div>
                        </div>
                    </div>
                    <div class="mcp-form-env-section mcp-form-section">
                        <div class="mcp-config-section">
                            <div class="mcp-config-section-title">Environment</div>
                            <div class="mcp-config-form-grid">
                                <label class="mcp-form-field mcp-form-field--full">
                                    <small>Environment</small>
                                    <textarea class="text_pole mcp-form-env" rows="4" placeholder="API_KEY=...">${DOMPurify.sanitize(draft.envText)}</textarea>
                                </label>
                            </div>
                        </div>
                    </div>
                </section>
                <section class="mcp-config-panel mcp-config-section-card" data-section="server-info">
                    <div class="mcp-config-panel-heading">
                        <div class="mcp-config-section-title">Server Info</div>
                        <small class="mcp-card-subtitle">Reference details from the registry entry or imported configuration.</small>
                    </div>
                    <div class="mcp-config-info-grid">
                        <div class="mcp-config-info-card">
                            <small>Type</small>
                            <strong>${draft.transportType === 'stdio' ? 'Local' : 'Remote'}</strong>
                        </div>
                        <div class="mcp-config-info-card">
                            <small>Transport</small>
                            <strong>${DOMPurify.sanitize(transportBadgeLabel)}</strong>
                        </div>
                        <div class="mcp-config-info-card">
                            <small>Version</small>
                            <strong>${DOMPurify.sanitize(draft.version || 'Unknown')}</strong>
                        </div>
                    </div>
                    ${draft.description ? `<div class="mcp-config-info-block"><small>Description</small><div>${DOMPurify.sanitize(draft.description)}</div></div>` : ''}
                    ${(draft.websiteUrl || draft.repositoryUrl || draft.docsUrl) ? `
                        <div class="mcp-config-info-block">
                            <small>Links</small>
                            <div class="mcp-config-popup-links">
                                ${draft.websiteUrl ? createMcpActionLink(draft.websiteUrl, 'Website').outerHTML : ''}
                                ${draft.repositoryUrl ? createMcpActionLink(draft.repositoryUrl, 'Source').outerHTML : ''}
                                ${draft.docsUrl ? createMcpActionLink(draft.docsUrl, 'Docs').outerHTML : ''}
                            </div>
                        </div>
                    ` : ''}
                </section>
            </div>
        </div>
        <div class="mcp-config-test-feedback" hidden></div>
    `;

    let values = null;
    let popup = null;
    let setTestFeedback = () => {};

    const buildDraft = (instance) => {
        const transportSelect = instance.dlg.querySelector('.mcp-form-transport');
        const authSelect = instance.dlg.querySelector('.mcp-form-auth');
        const nameInput = instance.dlg.querySelector('.mcp-form-name');
        const enabledInput = instance.dlg.querySelector('.mcp-form-enabled');
        const urlInput = instance.dlg.querySelector('.mcp-form-url');
        const headersInput = instance.dlg.querySelector('.mcp-form-headers');
        const oauthRedirectInput = instance.dlg.querySelector('.mcp-form-oauth-redirect');
        const oauthClientIdInput = instance.dlg.querySelector('.mcp-form-oauth-client-id');
        const oauthClientSecretInput = instance.dlg.querySelector('.mcp-form-oauth-client-secret');
        const oauthScopeInput = instance.dlg.querySelector('.mcp-form-oauth-scope');
        const commandInput = instance.dlg.querySelector('.mcp-form-command');
        const argsInput = instance.dlg.querySelector('.mcp-form-args');
        const cwdInput = instance.dlg.querySelector('.mcp-form-cwd');
        const envInput = instance.dlg.querySelector('.mcp-form-env');
        const timeoutInput = instance.dlg.querySelector('.mcp-form-timeout');

        return normalizeMcpServerConfig({
            ...draft,
            id: draft.id,
            name: nameInput instanceof HTMLInputElement ? nameInput.value : '',
            enabled: enabledInput instanceof HTMLInputElement ? enabledInput.checked : true,
            transportType: transportSelect instanceof HTMLSelectElement ? transportSelect.value : 'http',
            authType: authSelect instanceof HTMLSelectElement ? authSelect.value : 'none',
            url: urlInput instanceof HTMLInputElement ? urlInput.value : '',
            headersText: headersInput instanceof HTMLTextAreaElement ? headersInput.value : '',
            oauth: {
                redirectUrl: oauthRedirectInput instanceof HTMLInputElement ? oauthRedirectInput.value : '',
                clientId: oauthClientIdInput instanceof HTMLInputElement ? oauthClientIdInput.value : '',
                clientSecret: oauthClientSecretInput instanceof HTMLInputElement ? oauthClientSecretInput.value : '',
                scope: oauthScopeInput instanceof HTMLInputElement ? oauthScopeInput.value : '',
            },
            command: commandInput instanceof HTMLInputElement ? commandInput.value : '',
            argsText: argsInput instanceof HTMLTextAreaElement ? argsInput.value : '',
            cwd: cwdInput instanceof HTMLInputElement ? cwdInput.value : '',
            envText: envInput instanceof HTMLTextAreaElement ? envInput.value : '',
            timeoutMs: timeoutInput instanceof HTMLInputElement ? timeoutInput.value : draft.timeoutMs,
            unsafeStdioConfirmed: draft.unsafeStdioConfirmed,
        });
    };

    const validateDraft = async (serverDraft) => {
        if (!serverDraft.name) {
            toastr.warning('MCP server name is required.');
            return false;
        }

        if ((serverDraft.transportType === 'http' || serverDraft.transportType === 'sse') && !serverDraft.url) {
            toastr.warning('Remote MCP servers need a URL.');
            return false;
        }

        if ((serverDraft.transportType === 'http' || serverDraft.transportType === 'sse') && serverDraft.authType === 'oauth' && !serverDraft.oauth.redirectUrl) {
            toastr.warning('OAuth MCP servers need a redirect URL.');
            return false;
        }

        if (serverDraft.transportType === 'stdio' && !serverDraft.command) {
            toastr.warning('Stdio MCP servers need a command.');
            return false;
        }

        if (serverDraft.transportType === 'stdio' && serverDraft.unsafeStdioConfirmed !== true) {
            const confirmed = await Popup.show.confirm(
                'Allow Local MCP Command',
                '<p>This MCP server will start a local command on the SillyTavern host.</p><p>Only continue if you trust the command and its arguments.</p>',
                { leftAlign: true },
            );
            if (!confirmed) {
                return false;
            }
            serverDraft.unsafeStdioConfirmed = true;
            draft.unsafeStdioConfirmed = true;
        }

        return true;
    };

    popup = applyMcpPopupClasses(new Popup(form, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        okButton: 'Save',
        cancelButton: false,
        customButtons: [{
            text: 'Test Connection',
            icon: 'fa-plug',
            classes: ['mcp-popup-button-secondary'],
            action: async () => {
                if (!popup) {
                    return;
                }

                try {
                    setTestFeedback('Testing connection...', 'pending');
                    const testDraft = buildDraft(popup);
                    const valid = await validateDraft(testDraft);
                    if (!valid) {
                        setTestFeedback('', '');
                        return;
                    }

                    const result = await testMcpServerConnection(testDraft);
                    const details = [];
                    if (typeof result.toolCount === 'number') details.push(`${result.toolCount} tools`);
                    if (typeof result.resourceCount === 'number') details.push(`${result.resourceCount} resources`);
                    if (typeof result.promptCount === 'number') details.push(`${result.promptCount} prompts`);
                    if (result.stderr) details.push(result.stderr);
                    const summary = details.length > 0 ? `Connected. ${details.join(', ')}.` : 'Connected.';
                    setTestFeedback(summary, 'success');
                } catch (error) {
                    setTestFeedback(String(error?.message || error), 'error');
                    toastr.error(String(error?.message || error), 'MCP');
                }
            },
        }],
        onOpen: (instance) => {
            const testFeedback = instance.dlg.querySelector('.mcp-config-test-feedback');
            const navButtons = Array.from(instance.dlg.querySelectorAll('.mcp-config-nav-button'));
            const sectionNodes = Array.from(instance.dlg.querySelectorAll('.mcp-config-section-card'));
            const transportSelect = instance.dlg.querySelector('.mcp-form-transport');
            const authSelect = instance.dlg.querySelector('.mcp-form-auth');
            const httpSection = instance.dlg.querySelector('.mcp-form-http');
            const stdioSection = instance.dlg.querySelector('.mcp-form-stdio');
            const remoteAuthSection = instance.dlg.querySelector('.mcp-form-remote-auth');
            const oauthSection = instance.dlg.querySelector('.mcp-form-oauth');
            const envSection = instance.dlg.querySelector('.mcp-form-env-section');

            setTestFeedback = (message, state) => {
                if (!(testFeedback instanceof HTMLElement)) {
                    return;
                }

                const value = String(message || '').trim();
                testFeedback.hidden = !value;
                testFeedback.textContent = value;
                testFeedback.dataset.state = String(state || '');
            };

            const setActiveSection = (target) => {
                for (const button of navButtons) {
                    button.classList.toggle('is-active', button.dataset.target === target);
                }
                for (const section of sectionNodes) {
                    section.hidden = section.dataset.section !== target;
                }
            };

            for (const button of navButtons) {
                button.addEventListener('click', () => {
                    const target = button.dataset.target;
                    const section = sectionNodes.find(node => node.dataset.section === target);
                    if (!(section instanceof HTMLElement)) {
                        return;
                    }
                    setActiveSection(target);
                });
            }

            const syncTransportUi = () => {
                const isRemote = transportSelect instanceof HTMLSelectElement ? transportSelect.value !== 'stdio' : true;
                if (httpSection instanceof HTMLElement) {
                    httpSection.hidden = !isRemote;
                }
                if (stdioSection instanceof HTMLElement) {
                    stdioSection.hidden = isRemote;
                }
                if (remoteAuthSection instanceof HTMLElement) {
                    remoteAuthSection.hidden = !isRemote;
                }
                if (envSection instanceof HTMLElement) {
                    envSection.hidden = isRemote;
                }
                syncAuthUi();
            };

            const syncAuthUi = () => {
                const isRemote = transportSelect instanceof HTMLSelectElement ? transportSelect.value !== 'stdio' : true;
                const isOAuth = authSelect instanceof HTMLSelectElement ? authSelect.value === 'oauth' : false;
                if (oauthSection instanceof HTMLElement) {
                    oauthSection.hidden = !isRemote || !isOAuth;
                }
            };

            if (transportSelect instanceof HTMLSelectElement) {
                transportSelect.value = draft.transportType;
                transportSelect.addEventListener('change', syncTransportUi);
            }
            if (authSelect instanceof HTMLSelectElement) {
                authSelect.value = draft.authType;
                authSelect.addEventListener('change', syncAuthUi);
            }

            setActiveSection('configuration');
            syncTransportUi();
        },
        onClosing: async (instance) => {
            if (instance.result !== 1) {
                return true;
            }

            values = buildDraft(instance);
            return await validateDraft(values);
        },
    }), 'mcp-popup--config');

    popup.dlg.querySelector('.popup-button-ok')?.classList.add('menu_button_default');

    const result = await popup.show();
    return result === 1 ? values : null;
}

async function disconnectMcpServer(server, { workspace = getCurrentSandboxWorkspace(), character = getCurrentSandboxCharacterName() } = {}) {
    await callMcpApi('/api/extensions/tools/mcp/disconnect', {
        serverId: server.id,
        ...getSandboxRequestContext(workspace, character),
    });
    clearMcpToolsForServer(server.id);
    upsertMcpStatus(server.id, {
        connected: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
    });
    syncToolRegistryAfterMcpChange();
    refreshMcpSummaryUi();
}

async function addConfiguredMcpServer(server) {
    const existing = getMcpServers();
    setMcpServers([...existing, server]);
    if (server.enabled) {
        try {
            await refreshMcpServer(server, { reconnect: true });
        } catch (error) {
            upsertMcpStatus(server.id, { connected: false, lastError: String(error?.message || error) });
        }
    }
    syncToolRegistryAfterMcpChange();
    refreshMcpSummaryUi();
}

async function configureAndAddMcpServer(draft, forcedTransportType = null) {
    const server = await editMcpServerConfig(draft, forcedTransportType);
    if (!server) {
        return null;
    }

    await addConfiguredMcpServer(server);
    return server;
}

function normalizeImportedMcpServer(name, config) {
    const rawTransport = String(config?.transport || config?.transportType || '').toLowerCase();
    const hasCommand = Boolean(config?.command);
    const transportType = rawTransport.includes('sse')
        ? 'sse'
        : rawTransport.includes('http') || config?.url
            ? 'http'
            : hasCommand
                ? 'stdio'
                : 'http';
    const args = Array.isArray(config?.args) ? config.args : [];
    const headers = config?.headers && typeof config.headers === 'object' ? config.headers : {};
    const oauth = config?.oauth && typeof config.oauth === 'object' ? config.oauth : {};

    return normalizeMcpServerConfig({
        name,
        description: config?.description || '',
        version: config?.version || '',
        status: config?.status || '',
        websiteUrl: config?.websiteUrl || config?.website || '',
        repositoryUrl: config?.repositoryUrl || config?.source || '',
        docsUrl: config?.docsUrl || config?.documentationUrl || '',
        transportType,
        enabled: config?.enabled !== false && config?.disabled !== true,
        command: config?.command || '',
        args,
        cwd: config?.cwd || '',
        env: config?.env && typeof config.env === 'object' ? config.env : {},
        url: config?.url || config?.endpoint || '',
        headers,
        authType: config?.authType || config?.auth?.type || (Object.keys(oauth).length > 0 ? 'oauth' : 'none'),
        authRequired: config?.authRequired === true,
        oauth,
        timeoutMs: config?.timeoutMs || config?.timeout || 30000,
        unsafeStdioConfirmed: transportType !== 'stdio' || config?.unsafeStdioConfirmed === true,
    });
}

function tokenizeMcpCommandSnippet(rawText) {
    const input = String(rawText || '').trim();
    const tokens = [];
    let current = '';
    let quote = '';
    let escaping = false;

    for (const char of input) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = '';
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

function deriveMcpNameFromCommand(command, args = []) {
    const normalizedCommand = String(command || '').trim().toLowerCase();
    const normalizedArgs = Array.isArray(args) ? args.map(arg => String(arg || '').trim()).filter(Boolean) : [];

    if (normalizedCommand === 'docker') {
        const image = normalizedArgs.find((arg, index) => index > 0 && !arg.startsWith('-') && normalizedArgs[index - 1] !== 'run') || normalizedArgs.find(arg => !arg.startsWith('-') && arg !== 'run');
        return deriveMcpNameFromIdentifier(image, 'Docker MCP Server');
    }

    const packageArg = normalizedArgs.find(arg => !arg.startsWith('-'));
    return deriveMcpNameFromIdentifier(packageArg || command, 'MCP Server');
}

function normalizeImportedRegistryPayload(payload) {
    const server = payload?.server && typeof payload.server === 'object' ? payload.server : payload;
    const entry = {
        name: String(server?.name || '').trim(),
        title: String(server?.title || server?.name || 'MCP Server').trim(),
        remotes: Array.isArray(server?.remotes) ? server.remotes : [],
        packages: Array.isArray(server?.packages) ? server.packages : [],
    };
    const options = getMcpRegistryInstallOptions(entry);
    const preferredOption = options.find(option => option.kind === 'remote' && option.draft)
        || options.find(option => option.draft);

    return preferredOption?.draft ? [preferredOption.draft] : [];
}

function extractImportedRegistryServers(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        return [];
    }

    if (Array.isArray(parsed?.servers)) {
        return parsed.servers.flatMap(entry => normalizeImportedRegistryPayload(entry));
    }

    if (Array.isArray(parsed)) {
        return parsed.flatMap(entry => normalizeImportedRegistryPayload(entry));
    }

    if (parsed?.server || Array.isArray(parsed?.remotes) || Array.isArray(parsed?.packages)) {
        return normalizeImportedRegistryPayload(parsed);
    }

    return [];
}

function parseMcpServerImport(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) {
        throw new Error('Import text is empty.');
    }

    if (!/^[{\[]/.test(raw)) {
        const tokens = tokenizeMcpCommandSnippet(raw);
        if (tokens.length === 0) {
            throw new Error('Could not parse the command snippet.');
        }

        const [command, ...args] = tokens;
        return [normalizeMcpServerConfig({
            name: deriveMcpNameFromCommand(command, args),
            transportType: 'stdio',
            enabled: true,
            command,
            args,
        })];
    }

    const parsed = JSON.parse(raw);
    const importedRegistryServers = extractImportedRegistryServers(parsed);
    if (importedRegistryServers.length > 0) {
        return importedRegistryServers;
    }

    if (parsed?.command || parsed?.url || parsed?.endpoint) {
        return [normalizeImportedMcpServer(parsed.name || 'MCP Server', parsed)];
    }

    const source = parsed?.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed.mcpServers
        : Array.isArray(parsed)
            ? Object.fromEntries(parsed.map((server, index) => [server?.name || `server_${index + 1}`, server]))
            : parsed?.servers && typeof parsed.servers === 'object'
                ? parsed.servers
                : parsed;

    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('Import must be a JSON object with mcpServers, servers, or server entries.');
    }

    return Object.entries(source)
        .map(([name, config]) => normalizeImportedMcpServer(name, config))
        .filter(server => server.name && (server.url || server.command));
}

async function importMcpServersFromJson({
    title = 'Import MCP JSON',
    description = '<p>Paste a Claude-style <code>mcpServers</code> JSON object, an official MCP Registry <code>server.json</code>, a raw server object, or a single command such as <code>npx -y @modelcontextprotocol/server-filesystem .</code>.</p>',
} = {}) {
    const raw = await Popup.show.input(
        title,
        description,
        '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}',
        {
            rows: 12,
            leftAlign: true,
            okButton: 'Import',
            cancelButton: 'Cancel',
        },
    );

    if (raw === null) {
        return [];
    }

    return parseMcpServerImport(raw);
}

async function importAndAddMcpServers(options = {}) {
    const importedServers = await importMcpServersFromJson(options);
    if (importedServers.length === 0) {
        return [];
    }

    if (importedServers.some(server => server.transportType === 'stdio' && server.unsafeStdioConfirmed !== true)) {
        const confirmed = await Popup.show.confirm(
            'Allow Imported Local MCP Commands',
            '<p>One or more imported stdio MCP servers will start local commands on the SillyTavern host.</p><p>Only continue if you trust the imported config or command.</p>',
            { leftAlign: true },
        );
        if (!confirmed) {
            return [];
        }
        for (const server of importedServers) {
            if (server.transportType === 'stdio') {
                server.unsafeStdioConfirmed = true;
            }
        }
    }

    for (const server of importedServers) {
        await addConfiguredMcpServer(server);
    }

    return importedServers;
}

function createMcpSourceCard({ title, description, detailLines = [], buttons = [], iconClass = '', extraClass = '' }) {
    const card = document.createElement('section');
    card.className = `mcp-source-card ${extraClass}`.trim();

    if (iconClass) {
        const icon = document.createElement('div');
        icon.className = 'mcp-source-card-icon';
        icon.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
        card.append(icon);
    }

    const copy = document.createElement('div');
    copy.className = 'mcp-source-card-copy';

    const heading = document.createElement('strong');
    heading.textContent = title;
    const body = document.createElement('small');
    body.className = 'mcp-card-subtitle';
    body.textContent = description;
    copy.append(heading, body);

    for (const line of detailLines) {
        const detail = document.createElement('small');
        detail.className = 'mcp-card-subtitle';
        detail.textContent = line;
        copy.append(detail);
    }

    card.append(copy);

    if (buttons.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'mcp-source-card-actions';

        for (const buttonConfig of buttons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `menu_button ${buttonConfig.classes || ''}`.trim();
            button.textContent = buttonConfig.label;
            button.title = buttonConfig.title || buttonConfig.label;
            button.disabled = buttonConfig.disabled === true;
            button.addEventListener('click', () => buttonConfig.onClick?.());
            actions.append(button);
        }

        card.append(actions);
    }

    return card;
}

async function openMcpSelectionPopup(server) {
    const content = document.createElement('div');
    content.className = 'mcp-selection-popup';
    content.append(
        createMcpPopupSubheader('Select'),
        createMcpSourceCard({
            title: 'Resources',
            description: 'Select resources from this server.',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    await popup.completeCancelled();
                    await openMcpResourcePicker(server);
                },
            }],
        }),
        createMcpSourceCard({
            title: 'Prompts',
            description: 'Select prompts from this server.',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    await popup.completeCancelled();
                    await openMcpPromptPicker(server);
                },
            }],
        }),
    );

    const popup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    }), 'mcp-popup--selection');

    await popup.show();
}

async function openMcpRegistryInstallPopup(entry, onChanged = null) {
    const options = getMcpRegistryInstallOptions(entry);
    const hasRemote = options.some(option => option.kind === 'remote');
    const hasPackage = options.some(option => option.kind === 'package');
    const firstRemote = options.find(option => option.kind === 'remote');
    const firstPackage = options.find(option => option.kind === 'package');
    const authRequired = options.some(option => option.kind === 'remote'
        && Array.isArray(option.remote?.headers)
        && option.remote.headers.some(header => header?.isRequired));
    const content = document.createElement('div');
    content.className = 'mcp-registry-details';
    content.innerHTML = `
        <div class="mcp-registry-details-header">
            <div class="mcp-config-popup-identity">
                ${createMcpIcon(entry.iconUrl || entry.icon || entry.logoUrl, entry.title || entry.name || 'MCP').outerHTML}
                <div class="mcp-config-popup-copy">
                    <strong>${DOMPurify.sanitize(entry.title || entry.name || 'Registry entry')}</strong>
                    <small class="mcp-card-subtitle">${DOMPurify.sanitize(entry.description || '')}</small>
                    <div class="mcp-card-badges mcp-config-popup-meta"></div>
                </div>
            </div>
            <div class="mcp-config-popup-links">
                ${entry.websiteUrl ? createMcpActionLink(entry.websiteUrl, 'Website').outerHTML : ''}
                ${entry.repositoryUrl ? createMcpActionLink(entry.repositoryUrl, 'Source').outerHTML : ''}
                ${entry.links?.docsUrl ? createMcpActionLink(entry.links.docsUrl, 'Docs').outerHTML : ''}
            </div>
        </div>
        <div class="mcp-registry-options"></div>
    `;

    const meta = content.querySelector('.mcp-config-popup-meta');
    const optionsContainer = content.querySelector('.mcp-registry-options');
    if (meta instanceof HTMLElement) {
        if (hasPackage && !hasRemote) {
            meta.append(createMcpBadge('Local'));
            meta.append(createMcpBadge(String(firstPackage?.pkg?.transportType || 'stdio').toLowerCase() === 'stdio' ? 'stdio' : String(firstPackage?.pkg?.transportType || 'stdio').toUpperCase()));
        } else if (hasRemote && !hasPackage) {
            meta.append(createMcpBadge('Remote'));
            meta.append(createMcpBadge(String(firstRemote?.remote?.type || '').toLowerCase() === 'sse' ? 'SSE' : 'HTTP'));
        } else {
            if (hasRemote) meta.append(createMcpBadge('Remote'));
            if (hasPackage) meta.append(createMcpBadge('Local'));
        }
        if (entry.version) meta.append(createMcpBadge(`v${entry.version}`));
        if (entry.status && entry.status !== 'active') meta.append(createMcpBadge(entry.status, entry.status === 'deprecated' ? 'warning' : 'default'));
        if (authRequired) meta.append(createMcpBadge('Needs auth', 'warning'));
    }

    if (options.length === 0) {
        const empty = document.createElement('small');
        empty.className = 'mcp-empty-state';
        empty.textContent = 'This registry entry did not include a remote endpoint or a supported local package install.';
        optionsContainer?.append(empty);
    } else if (optionsContainer instanceof HTMLElement) {
        for (const option of options) {
            const installed = option.draft ? isMcpServerInstalled(option.draft) : false;
            const card = document.createElement('article');
            card.className = 'mcp-registry-option';

            const main = document.createElement('div');
            main.className = 'mcp-registry-option-main';

            const icon = document.createElement('div');
            icon.className = 'mcp-registry-option-icon';
            icon.innerHTML = option.kind === 'package'
                ? '<i class="fa-solid fa-terminal"></i>'
                : '<i class="fa-solid fa-globe"></i>';

            const copy = document.createElement('div');
            copy.className = 'mcp-registry-row-copy';
            const title = document.createElement('strong');
            title.textContent = option.title;
            const detail = document.createElement('div');
            detail.className = 'mcp-registry-option-detail';
            detail.textContent = option.detail;
            const subtitle = document.createElement('small');
            subtitle.className = 'mcp-card-subtitle';
            subtitle.textContent = option.description;
            copy.append(title, detail, subtitle);
            main.append(icon, copy);

            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'menu_button';
            action.textContent = installed ? 'Installed' : 'Select';
            action.disabled = installed || !option.draft;
            action.addEventListener('click', async () => {
                const created = await configureAndAddMcpServer(option.draft, option.draft.transportType);
                if (created) {
                    onChanged?.();
                    await popup.completeCancelled();
                }
            });

            card.append(main, action);
            optionsContainer.append(card);
        }
    }

    if (entry.links?.docsUrl) {
        const docsLink = createMcpLink(entry.links.docsUrl, 'Registry entry docs');
        docsLink.classList.add('mcp-docs-link');
        content.append(docsLink);
    }

    const popup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    }), 'mcp-popup--registry-details');

    await popup.show();
}

async function openOfficialMcpRegistryBrowser(onChanged = null) {
    const content = document.createElement('div');
    content.className = 'mcp-registry-browser';
    const heading = createMcpPopupSubheader('Browse Official Registry');

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole mcp-registry-search';
    search.placeholder = 'Search registry...';

    const openButton = createMcpActionLink('https://registry.modelcontextprotocol.io/', 'Open Registry');
    openButton.addEventListener('click', event => {
        event.preventDefault();
        openExternalLink('https://registry.modelcontextprotocol.io/');
    });

    heading.querySelector('.mcp-popup-subheader-main')?.append(createMcpPopupHeaderActions([openButton]));
    heading.append(search);

    const list = document.createElement('div');
    list.className = 'mcp-registry-list';

    content.append(heading, list);

    const state = {
        query: '',
        loading: false,
        entries: [],
        nextCursor: '',
        exhausted: false,
        totalCount: null,
        hasLoaded: false,
    };

    let searchTimer = null;

    const render = () => {
        list.replaceChildren();

        if (state.hasLoaded && !state.loading && state.entries.length === 0) {
            const empty = document.createElement('small');
            empty.className = 'mcp-empty-state';
            empty.textContent = 'No results.';
            list.append(empty);
            return;
        }

        for (const entry of state.entries) {
            const installOptions = getMcpRegistryInstallOptions(entry);
            const installed = installOptions.some(option => option.draft && isMcpServerInstalled(option.draft));
            const row = document.createElement('div');
            row.className = 'mcp-registry-row';

            const identity = document.createElement('div');
            identity.className = 'mcp-registry-row-main';
            identity.append(createMcpIcon(entry.iconUrl || entry.icon || entry.logoUrl, entry.title || entry.name || 'MCP'));

            const copy = document.createElement('div');
            copy.className = 'mcp-registry-row-copy';
            const title = document.createElement('strong');
            title.textContent = entry.title || entry.name || 'Registry entry';
            const description = document.createElement('small');
            description.className = 'mcp-card-subtitle';
            description.textContent = entry.description || entry.name || '';
            const badges = document.createElement('div');
            badges.className = 'mcp-card-badges';
            if (installOptions.some(option => option.kind === 'remote')) badges.append(createMcpBadge('Remote'));
            if (installOptions.some(option => option.kind === 'package')) badges.append(createMcpBadge('Local'));
            if (installOptions.length > 0) {
                const first = installOptions[0];
                badges.append(createMcpBadge(first.kind === 'remote' ? first.title.replace(' endpoint', '') : 'stdio'));
            }
            if (entry.version) badges.append(createMcpBadge(`v${entry.version}`));
            if (entry.status) badges.append(createMcpBadge(entry.status));
            copy.append(title, description, badges);
            identity.append(copy);

            const links = document.createElement('div');
            links.className = 'mcp-registry-row-links';
            for (const link of [
                entry.links?.docsUrl ? { label: 'Docs', url: entry.links.docsUrl } : null,
                entry.websiteUrl ? { label: 'Website', url: entry.websiteUrl } : null,
                entry.repositoryUrl ? { label: 'Source', url: entry.repositoryUrl } : null,
            ].filter(Boolean)) {
                links.append(createMcpActionLink(link.url, link.label));
            }

            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'menu_button';
            action.textContent = installed ? 'Installed' : 'Select';
            action.disabled = installed;
            action.addEventListener('click', () => openMcpRegistryInstallPopup(entry, onChanged));

            row.append(identity, links, action);
            list.append(row);
        }
    };

    const load = async ({ append = false } = {}) => {
        if (state.loading || (append && (state.exhausted || !state.nextCursor))) {
            return;
        }

        state.loading = true;

        try {
            const result = await callMcpApi('/api/extensions/tools/mcp/registry/list', {
                query: state.query,
                cursor: append ? state.nextCursor : '',
                limit: 40,
            });
            const entries = Array.isArray(result?.entries) ? result.entries : [];
            state.entries = append
                ? [...state.entries, ...entries]
                : entries;
            state.nextCursor = String(result?.nextCursor || '').trim();
            state.exhausted = result?.exhausted === true || !state.nextCursor;
            state.totalCount = Number.isFinite(result?.totalCount) ? result.totalCount : null;
            state.hasLoaded = true;
        } catch (error) {
            state.hasLoaded = true;
            toastr.error(String(error?.message || error), 'Official MCP Registry');
        } finally {
            state.loading = false;
            render();
        }
    };

    search.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            state.query = search.value.trim();
            state.entries = [];
            state.nextCursor = '';
            state.exhausted = false;
            state.totalCount = null;
            void load();
        }, 250);
    });

    search.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            window.clearTimeout(searchTimer);
            state.query = search.value.trim();
            state.entries = [];
            state.nextCursor = '';
            state.exhausted = false;
            state.totalCount = null;
            void load();
        }
    });

    render();

    const popup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
        onOpen: (instance) => {
            const popupContent = instance.dlg.querySelector('.popup-content');
            if (!(popupContent instanceof HTMLElement)) {
                return;
            }

            const handleScroll = () => {
                if (state.loading || state.exhausted) {
                    return;
                }

                const remaining = popupContent.scrollHeight - popupContent.scrollTop - popupContent.clientHeight;
                if (remaining < 160) {
                    void load({ append: true });
                }
            };

            popupContent.addEventListener('scroll', handleScroll);
        },
    }), 'mcp-popup--registry-browser');

    popup.show().catch(error => console.error('Failed to show official MCP registry browser:', error));
    await load();
}

async function openMcpAddSourcePopup(onChanged = null) {
    const content = document.createElement('div');
    content.className = 'mcp-add-popup';
    const header = createMcpPopupSubheader('Add Server');
    const docsLink = createMcpActionLink('https://modelcontextprotocol.io/docs', 'MCP Server Docs');
    docsLink.addEventListener('click', event => {
        event.preventDefault();
        openExternalLink('https://modelcontextprotocol.io/docs');
    });
    header.querySelector('.mcp-popup-subheader-main')?.append(createMcpPopupHeaderActions([docsLink]));
    content.append(header);

    let addPopup = null;
    const cards = [
        createMcpSourceCard({
            title: 'Browse Official Registry',
            description: 'Search the official registry inside SillyTavern.',
            iconClass: 'fa-magnifying-glass',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    await addPopup?.completeCancelled();
                    await openOfficialMcpRegistryBrowser(onChanged);
                },
            }],
        }),
        createMcpSourceCard({
            title: 'Import JSON',
            description: 'Paste a server JSON or config object.',
            iconClass: 'fa-file-code',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    const imported = await importAndAddMcpServers({
                        title: 'Import MCP JSON',
                        description: '<p>Paste a server JSON, registry entry JSON, or an <code>mcpServers</code> object.</p>',
                    });
                    if (imported.length > 0) {
                        await addPopup?.completeCancelled();
                        onChanged?.();
                    }
                },
            }],
        }),
        createMcpSourceCard({
            title: 'Import Snippet',
            description: 'Paste a command or install snippet.',
            iconClass: 'fa-code',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    const imported = await importAndAddMcpServers({
                        title: 'Import MCP Snippet',
                        description: '<p>Paste a command, config snippet, or install line.</p>',
                    });
                    if (imported.length > 0) {
                        await addPopup?.completeCancelled();
                        onChanged?.();
                    }
                },
            }],
        }),
        createMcpSourceCard({
            title: 'Add Manually',
            description: 'Enter the transport and connection details yourself.',
            iconClass: 'fa-terminal',
            buttons: [{
                label: 'Select',
                onClick: async () => {
                    await addPopup?.completeCancelled();
                    const created = await configureAndAddMcpServer(null, 'http');
                    if (created) {
                        onChanged?.();
                    }
                },
            }],
        }),
    ];

    cards.forEach(card => content.append(card));

    addPopup = applyMcpPopupClasses(new Popup(content, POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    }), 'mcp-popup--add');

    await addPopup.show();
}

async function openMcpManagerPopup() {
    const popup = applyMcpPopupClasses(new Popup(getMcpManagerPopupContent(), POPUP_TYPE.TEXT, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
        onOpen: async (popup) => {
            const statusElement = popup.dlg.querySelector('.mcp-manager-status');
            const contextStatusElement = popup.dlg.querySelector('.mcp-manager-context-status');
            const selectionTitleElement = popup.dlg.querySelector('.mcp-manager-selection-title');
            const serverList = popup.dlg.querySelector('.mcp-manager-server-list');
            const contextList = popup.dlg.querySelector('.mcp-manager-context-list');
            const addButton = popup.dlg.querySelector('.mcp-manager-add');
            const refreshAllButton = popup.dlg.querySelector('.mcp-manager-refresh-all');
            const searchInput = popup.dlg.querySelector('.mcp-manager-search');

            if (!(statusElement instanceof HTMLElement) || !(contextStatusElement instanceof HTMLElement) || !(selectionTitleElement instanceof HTMLElement) || !(serverList instanceof HTMLElement) || !(contextList instanceof HTMLElement) || !(addButton instanceof HTMLButtonElement) || !(refreshAllButton instanceof HTMLButtonElement) || !(searchInput instanceof HTMLInputElement)) {
                return;
            }

            let searchTerm = '';

            const render = () => {
                const allServers = getMcpServers();
                const enabledServers = allServers.filter(server => server.enabled);
                const normalizedSearch = searchTerm.trim().toLowerCase();
                const servers = normalizedSearch
                    ? allServers.filter(server => [server.name, server.description, server.id]
                        .map(value => String(value || '').toLowerCase())
                        .some(value => value.includes(normalizedSearch)))
                    : allServers;
                serverList.replaceChildren();
                selectionTitleElement.textContent = `Enabled in ${getMcpWorkspaceLabel()}`;
                statusElement.textContent = allServers.length === 0
                    ? 'No servers added yet.'
                    : `${allServers.length} server${allServers.length === 1 ? '' : 's'}`;

                contextStatusElement.textContent = enabledServers.length > 0
                    ? `${enabledServers.length} enabled`
                    : '';
                renderMcpSelectedContext(contextList, render);

                if (servers.length === 0) {
                    const empty = document.createElement('small');
                    empty.className = 'mcp-empty-state';
                    empty.textContent = normalizedSearch ? 'No matching servers.' : 'No servers added yet.';
                    serverList.append(empty);
                    return;
                }

                for (const server of servers) {
                    const status = mcpServerStatus.get(server.id) ?? {};
                    const tone = getMcpServerStatusTone(server, status);
                    const card = document.createElement('article');
                    card.className = 'mcp-server-card';

                    const info = document.createElement('div');
                    info.className = 'mcp-server-card-main';
                    info.append(createMcpIcon(server.iconUrl, server.name || server.id || 'MCP'));

                    const copy = document.createElement('div');
                    copy.className = 'mcp-server-card-copy';
                    const heading = document.createElement('div');
                    heading.className = 'mcp-server-card-heading';
                    const titleRow = document.createElement('div');
                    titleRow.className = 'mcp-server-card-title-row';
                    const title = document.createElement('strong');
                    title.textContent = server.name || server.id;
                    const meta = document.createElement('div');
                    meta.className = 'mcp-card-badges mcp-server-card-meta';
                    meta.append(createMcpBadge(server.transportType === 'stdio' ? 'stdio' : server.transportType === 'sse' ? 'SSE' : 'HTTP'));
                    if (server.version) meta.append(createMcpBadge(`v${server.version}`));
                    if (server.authRequired || server.authType === 'oauth' || /^\s*authorization:/i.test(server.headersText)) meta.append(createMcpBadge('Needs auth', 'warning'));
                    titleRow.append(title, meta);

                    const stateBadge = createMcpBadge(tone.label, tone.tone);
                    stateBadge.classList.add('mcp-server-card-status');
                    heading.append(titleRow, stateBadge);

                    const description = document.createElement('small');
                    description.className = 'mcp-card-subtitle';
                    description.textContent = server.description || 'No description.';
                    copy.append(heading, description);
                    info.append(copy);

                    const enableButton = document.createElement('button');
                    enableButton.type = 'button';
                    enableButton.className = 'menu_button';
                    enableButton.textContent = server.enabled ? 'Disable' : 'Enable';
                    enableButton.addEventListener('click', async () => {
                        try {
                            await toggleMcpServerEnabled(server, !server.enabled);
                        } catch (error) {
                            toastr.error(String(error?.message || error), `MCP: ${server.name || server.id}`);
                        }
                        render();
                    });

                    const footer = document.createElement('div');
                    footer.className = 'mcp-server-card-footer';
                    const controls = document.createElement('div');
                    controls.className = 'mcp-server-card-controls';

                    const links = document.createElement('div');
                    links.className = 'mcp-server-links';
                    for (const link of [
                        server.websiteUrl ? { label: 'Website', url: server.websiteUrl } : null,
                        server.repositoryUrl ? { label: 'Source', url: server.repositoryUrl } : null,
                        server.docsUrl ? { label: 'Docs', url: server.docsUrl } : null,
                    ].filter(Boolean)) {
                        links.append(createMcpActionLink(link.url, link.label));
                    }

                    const editButton = document.createElement('button');
                    editButton.type = 'button';
                    editButton.className = 'menu_button';
                    editButton.textContent = 'Configure';
                    editButton.addEventListener('click', async () => {
                        const updated = await editMcpServerConfig(server);
                        if (!updated) {
                            return;
                        }

                        const servers = getAllMcpServers().map(item => item.id === server.id ? updated : item);
                        setAllMcpServers(servers);
                        setMcpServerEnabledForWorkspace(updated.id, updated.enabled);
                        removeMcpStatus(server.id);
                        if (updated.enabled) {
                            try {
                                await refreshMcpServer(updated, { reconnect: true });
                            } catch (error) {
                                upsertMcpStatus(updated.id, { connected: false, lastError: String(error?.message || error) });
                            }
                        } else if (status.connected) {
                            await disconnectMcpServer(updated);
                        } else {
                            clearMcpToolsForServer(updated.id);
                            removeMcpStatus(updated.id);
                        }
                        syncToolRegistryAfterMcpChange();
                        refreshMcpSummaryUi();
                        render();
                    });

                    const testButton = document.createElement('button');
                    testButton.type = 'button';
                    testButton.className = 'menu_button';
                    testButton.textContent = 'Test';
                    testButton.disabled = !server.enabled;
                    testButton.addEventListener('click', async () => {
                        upsertMcpStatus(server.id, { testing: true });
                        render();
                        try {
                            await testMcpServerConnection(server);
                            upsertMcpStatus(server.id, { testing: false });
                            render();
                        } catch (error) {
                            upsertMcpStatus(server.id, { testing: false });
                            render();
                            toastr.error(String(error?.message || error), `MCP: ${server.name || server.id}`);
                        }
                    });

                    const deleteButton = document.createElement('button');
                    deleteButton.type = 'button';
                    deleteButton.className = 'menu_button menu_button_icon';
                    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
                    deleteButton.title = 'Remove';
                    deleteButton.addEventListener('click', async () => {
                        const confirmed = await Popup.show.confirm(
                            'Delete MCP Server',
                            `<p>Remove <strong>${DOMPurify.sanitize(server.name || server.id)}</strong> from settings?</p>`,
                            { leftAlign: true },
                        );
                        if (!confirmed) {
                            return;
                        }

                        setAllMcpServers(getAllMcpServers().filter(item => item.id !== server.id));
                        purgeMcpSelectionsForServer(server.id, null);
                        removeMcpStatus(server.id);
                        if (status.connected) {
                            await disconnectMcpServer(server);
                        } else {
                            clearMcpToolsForServer(server.id);
                            syncToolRegistryAfterMcpChange();
                            refreshMcpSummaryUi();
                        }
                        render();
                    });

                    controls.append(enableButton);
                    if (links.childElementCount > 0) {
                        controls.append(links);
                    }
                    controls.append(editButton, testButton, deleteButton);
                    footer.append(controls);

                    card.append(info);

                    if (status.lastError) {
                        const error = document.createElement('small');
                        error.className = 'mcp-card-error';
                        error.textContent = status.lastError;
                        card.append(error);
                    } else if (status.stderr) {
                        const stderr = document.createElement('small');
                        stderr.className = 'mcp-card-subtitle';
                        stderr.textContent = status.stderr;
                        card.append(stderr);
                    }

                    card.append(footer);

                    serverList.append(card);
                }
            };

            const handleContextUpdate = () => render();
            document.addEventListener(MCP_CONTEXT_UPDATED_EVENT, handleContextUpdate);
            popup.onClose = async () => {
                document.removeEventListener(MCP_CONTEXT_UPDATED_EVENT, handleContextUpdate);
            };

            addButton.addEventListener('click', async () => {
                await openMcpAddSourcePopup(render);
                render();
            });

            refreshAllButton.addEventListener('click', async () => {
                try {
                    await refreshAllMcpServers({ notify: true });
                    render();
                } catch (error) {
                    toastr.error(String(error?.message || error), 'MCP');
                }
            });

            searchInput.addEventListener('input', () => {
                searchTerm = searchInput.value;
                render();
            });

            render();
        },
    }), 'mcp-popup--manager');

    await popup.show();
}

async function initMcpUi() {
    const manageButton = getMcpManageButtonElement();
    const refreshButton = getMcpRefreshButtonElement();

    if (manageButton && !mcpManageButtonInitialized) {
        manageButton.addEventListener('click', () => {
            void openMcpManagerPopup();
        });
        mcpManageButtonInitialized = true;
    }

    if (refreshButton && !mcpRefreshButtonInitialized) {
        refreshButton.addEventListener('click', () => {
            void syncActiveMcpWorkspace({ forceRefresh: true, notify: true }).catch(error => {
                toastr.error(String(error?.message || error), 'MCP');
            });
        });
        mcpRefreshButtonInitialized = true;
    }

    if (!mcpUiInitialized) {
        ensureMcpSettingsShape();
        mcpUiInitialized = true;
    }

    refreshMcpSummaryUi();
}

function getMetadataWorkspace() {
    return typeof chat_metadata?.sandbox_workspace === 'string'
        ? chat_metadata.sandbox_workspace.trim()
        : '';
}

async function refreshSandboxWorkspaceSelector({ persistDefault = false } = {}) {
    const select = getSandboxWorkspaceSelectElement();
    if (!select) {
        return;
    }

    const metadataWorkspace = getMetadataWorkspace();
    const fallbackWorkspace = getDefaultSandboxWorkspace();
    const selectedWorkspace = metadataWorkspace || fallbackWorkspace;
    const needsPersist = !metadataWorkspace;

    if (needsPersist) {
        setSandboxWorkspaceForCurrentChat(selectedWorkspace);
        if (persistDefault) {
            await saveChatConditional();
        }
    }

    const workspaceNames = await fetchSandboxWorkspaces();
    const uniqueWorkspaces = [...new Set(workspaceNames.map(x => String(x || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));

    if (selectedWorkspace !== SANDBOX_ROOT_WORKSPACE && !uniqueWorkspaces.includes(selectedWorkspace)) {
        uniqueWorkspaces.unshift(selectedWorkspace);
    }

    select.dataset.loading = 'true';
    select.innerHTML = '';

    const rootOption = document.createElement('option');
    rootOption.value = SANDBOX_ROOT_WORKSPACE;
    rootOption.textContent = 'uploads';
    select.append(rootOption);

    for (const workspace of uniqueWorkspaces) {
        if (workspace === SANDBOX_ROOT_WORKSPACE) {
            continue;
        }

        const option = document.createElement('option');
        option.value = workspace;
        option.textContent = workspace;
        select.append(option);
    }

    select.value = selectedWorkspace;
    select.dataset.previousWorkspace = selectedWorkspace;
    select.disabled = false;
    select.removeAttribute('data-loading');
}

async function promptCreateSandboxWorkspace() {
    const input = await Popup.show.input('New Workspace', 'Enter a name for the new workspace:');
    if (!input) {
        return null;
    }

    const sanitized = await getSanitizedFilename(String(input));
    const workspace = String(sanitized || '').trim();
    if (!workspace) {
        toastr.warning('Workspace name cannot be empty.');
        return null;
    }

    const created = await createSandboxWorkspace(workspace);
    if (!created) {
        return null;
    }

    await persistSandboxWorkspaceForCurrentChat(workspace);
    await refreshSandboxWorkspaceSelector();
    await syncActiveMcpWorkspace({ forceRefresh: true });
    return workspace;
}

async function onSandboxWorkspaceChange(event) {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.dataset.loading === 'true') {
        return;
    }

    const selectedValue = String(select.value || '').trim();
    const previousWorkspace = select.dataset.previousWorkspace || getCurrentSandboxWorkspace();

    if (!selectedValue || selectedValue === WORKSPACE_SEPARATOR_OPTION) {
        select.value = previousWorkspace;
        return;
    }

    if (selectedValue === NEW_WORKSPACE_OPTION) {
        const workspace = await promptCreateSandboxWorkspace();
        if (!workspace) {
            select.value = previousWorkspace;
            return;
        }

        return;
    }

    if (selectedValue === previousWorkspace) {
        return;
    }

    await persistSandboxWorkspaceForCurrentChat(selectedValue);
    select.dataset.previousWorkspace = selectedValue;
    await syncActiveMcpWorkspace({ forceRefresh: true });
}

async function initSandboxWorkspaceSelector() {
    const select = getSandboxWorkspaceSelectElement();
    const manageButton = getSandboxWorkspaceManageButtonElement();
    const refreshButton = getSandboxWorkspaceRefreshButtonElement();
    const addButton = getSandboxWorkspaceAddButtonElement();
    if (!select && !manageButton && !refreshButton && !addButton) {
        return;
    }

    if (manageButton && !sandboxWorkspaceManageButtonInitialized) {
        manageButton.addEventListener('click', () => {
            void openSandboxManagerPopup();
        });
        sandboxWorkspaceManageButtonInitialized = true;
    }

    if (refreshButton && !sandboxWorkspaceRefreshButtonInitialized) {
        refreshButton.addEventListener('click', () => {
            void refreshSandboxWorkspaceSelector();
        });
        sandboxWorkspaceRefreshButtonInitialized = true;
    }

    if (addButton && !sandboxWorkspaceAddButtonInitialized) {
        addButton.addEventListener('click', async () => {
            await promptCreateSandboxWorkspace();
        });
        sandboxWorkspaceAddButtonInitialized = true;
    }

    if (!select) {
        return;
    }

    if (!sandboxWorkspaceSelectorInitialized) {
        select.addEventListener('change', onSandboxWorkspaceChange);
        sandboxWorkspaceSelectorInitialized = true;
    }

    await refreshSandboxWorkspaceSelector();
}

function showNativeToolCallingMigrationToast() {
    if (accountStorage.getItem(NATIVE_TOOL_CALLING_MIGRATION_NOTICE_KEY) === 'true') {
        return;
    }

    const toast = toastr.info(
        'Tool calls now use XML. Existing chats with tool calls may need a reminder to the model that the tools changed. New chats include the new format automatically. Click to dismiss.',
        'Tool Calling',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            preventDuplicates: true,
            tapToDismiss: true,
            onclick: () => {
                accountStorage.setItem(NATIVE_TOOL_CALLING_MIGRATION_NOTICE_KEY, 'true');
                toastr.clear(toast);
            },
        },
    );
}

export function initToolCalling() {
    eventSource.on(event_types.DANGEROUS_TOOLS_TOGGLED, () => {
        // Only refresh the native tool commands if the feature is currently active.
        if (oai_settings.native_tool_calling) {
            ToolManager.registerNativeToolCommand();
        }
    });

    eventSource.on(event_types.IMAGE_GENERATION_TOGGLED, () => {
        if (oai_settings.native_tool_calling) {
            ToolManager.registerNativeToolCommand();
        }
    });

    eventSource.on(event_types.BROWSER_TOOLS_TOGGLED, () => {
        if (oai_settings.native_tool_calling) {
            ToolManager.registerNativeToolCommand();
        }
    });

    // Refresh tool registration after all settings (including power_user) have been loaded.
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, async () => {
        await initSandboxWorkspaceSelector();
        await initMcpUi();
        showNativeToolCallingMigrationToast();
        await syncActiveMcpWorkspace({ forceRefresh: true });
        refreshMcpSummaryUi();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await refreshSandboxWorkspaceSelector({ persistDefault: true });
        await syncActiveMcpWorkspace();
        refreshMcpSummaryUi();
    });
}
