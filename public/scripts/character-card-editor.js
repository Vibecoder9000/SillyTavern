import { characters, this_chid, saveCharacterDebounced, generateRawData, extractMessageFromData, cleanUpMessage, eventSource, event_types, messageFormatting, getRequestHeaders, main_api } from '../script.js';
import { isImageInliningSupported, Message, oai_settings } from './openai.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { parseReasoningStream } from './reasoning.js';
import { accountStorage } from './util/AccountStorage.js';
import { getTokenCountAsync } from './tokenizers.js';
import { cancelDebounce, debounce, escapeHtml, getBase64Async, getFileExtension, getStringHash, saveBase64AsFile, uuidv4 } from './utils.js';
import { DiffMatchPatch, morphdom } from '../lib.js';
import { ToolManager } from './tool-calling.js';
import { resolveDeleteCardSpan, resolveInsertCardText, resolveReplaceCardText } from './character-card-edit.js';
import { loadCharacterDesignerPrompts, renderCharacterDesignerPrompt } from './character-designer-prompt.js';
import { normalizeCharacterDesignerFieldLabel, resolveCharacterDesignerFieldAlias } from './character-designer-fields.js';

const WORKSPACE_PREFIX = 'st-character-card-editor:';
const CHARACTER_DESIGNER_XML_SCOPE = 'character-designer';
const CHARACTER_DESIGNER_MODE_KEY = 'st-character-designer:questioning-mode';
const MAX_HISTORY = 80;
const MAX_CHECKPOINTS = 24;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_SECONDS = .05;
const TOOL_PARSE_CACHE_LIMIT = 64;
const MAX_TOOL_RETRIES = 7;
const MAX_TOOL_CONTEXT_CHANGED_LINES = 12;
const UNCHANGED_READ_RESULT_SUFFIX = ' unchanged; use its value from original_card.';
const MAX_CARD_CHANGE_CONTEXT_LENGTH = 4000;
const CARD_CHANGE_TRUNCATION_SUFFIX = '... truncated';
const MAX_FIELD_HEIGHT = () => Math.floor(window.innerHeight * .75);
const FIELDS = Object.freeze([
    { id: 'description', label: 'Description', path: 'description', section: 'permanent' },
    { id: 'greetings', label: 'Greetings', path: 'greetings', type: 'collection', section: 'temporary' },
    { id: 'systemPrompt', label: 'System Prompt', path: 'system_prompt', section: 'permanent' },
    { id: 'summary', label: 'Personality Summary', path: 'personality', section: 'permanent' },
    { id: 'scenario', label: 'Scenario', path: 'scenario', section: 'permanent' },
    { id: 'characterNote', label: 'Character Note', path: 'extensions.depth_prompt.prompt', section: 'temporary' },
    { id: 'postHistory', label: 'Post History', path: 'post_history_instructions', section: 'permanent' },
    { id: 'depth', label: 'Depth', path: 'extensions.depth_prompt.depth', type: 'number', section: 'temporary' },
    { id: 'examples', label: 'Examples', path: 'mes_example', type: 'collection', section: 'temporary' },
    { id: 'createdBy', label: 'Created By', path: 'creator', section: 'metadata' },
    { id: 'creatorNotes', label: "Creator's Notes", path: 'creator_notes', section: 'metadata' },
    { id: 'tags', label: 'Tags', path: 'tags', section: 'metadata' },
    { id: 'version', label: 'Version', path: 'character_version', section: 'metadata' },
]);
const CARD_SECTIONS = Object.freeze([
    { id: 'permanent', label: 'Permanent (Always)' },
    { id: 'temporary', label: 'Temporary (Usually)' },
    { id: 'lorebook', label: 'Lorebook (Sometimes)' },
    { id: 'metadata', label: 'Metadata (Never)' },
].map(section => ({
    ...section,
    fields: FIELDS.filter(field => field.section === section.id).map(field => field.id),
})));
const DEFAULT_CARD_SECTION = CARD_SECTIONS[0].id;
const cardSectionById = new Map(CARD_SECTIONS.map(section => [section.id, section]));
const cardSectionByField = new Map(CARD_SECTIONS.flatMap(section => section.fields.map(field => [field, section.id])));
let characterDesignerPromptResource = null;
const toolString = description => ({ type: 'string', description });
const toolField = () => toolString('Editor field label; First Greeting; Alternate Greeting N; Greeting N; Example Message N; or Example N.');
const CHARACTER_DESIGNER_TOOL_SPECS = [
    { name: 'read_card_section', kind: 'read', description: 'Read the current complete value of one field or numbered Greeting/Example when the original card is no longer current.', properties: { field: toolField() }, required: ['field'] },
    { name: 'replace_card_text', kind: 'edit', description: 'Replace one exact unique string in a text field. Matching is case- and whitespace-sensitive except that CRLF is treated as LF. find may span lines; replace may be empty.', properties: { field: toolField(), find: toolString('Exact unique current text to replace.'), replace: toolString('Verbatim replacement text; may be empty.') }, required: ['field', 'find', 'replace'] },
    { name: 'delete_card_span', kind: 'edit', description: 'Delete an exact span in a text field. Deletion starts at the unique from anchor and stops immediately before the unique until anchor, preserving until.', properties: { field: toolField(), from: toolString('Exact unique starting anchor; included in the deletion.'), until: toolString('Exact unique ending anchor; preserved after the deletion.') }, required: ['field', 'from', 'until'] },
    { name: 'insert_card_text', kind: 'edit', description: 'Insert text verbatim before or after one exact unique anchor, or at the start or end of a text field. Supply all desired whitespace and newlines.', properties: { field: toolField(), content: toolString('Non-empty text to insert verbatim.'), position: { type: 'string', enum: ['before', 'after', 'start', 'end'], description: 'Insertion position. before and after require anchor; start and end forbid it.' }, anchor: toolString('Exact unique anchor required only for before or after.') }, required: ['field', 'content', 'position'] },
    { name: 'rewrite_card_field', kind: 'edit', description: 'Replace the complete value of exactly one ordinary field or one numbered Greeting/Example. Use only for substantial rewrites.', properties: { field: toolField(), content: toolString('Complete replacement value. Depth requires a nonnegative integer string.') }, required: ['field', 'content'] },
    { name: 'read_lorebook', kind: 'lore', description: 'Read the complete editable fields of all Character Book entries, including stable entry IDs.', properties: {} },
    { name: 'edit_lorebook_entry', kind: 'lore', description: 'Create an entry when entry_id is omitted, or update the named entry. Include at least one editable property. Complete content replaces the whole entry body; advanced properties are preserved.', properties: { entry_id: toolString('Stable entry ID from read_lorebook.'), name: toolString('Entry name.'), content: toolString('Complete entry content.'), keys: { type: 'array', description: 'Non-empty trigger strings.', items: { type: 'string' } }, constant: { type: 'boolean', description: 'Whether the entry is always active.' } } },
    { name: 'delete_lorebook_entry', kind: 'lore', description: 'Delete exactly one Character Book entry identified by its stable entry ID.', properties: { entry_id: toolString('Stable entry ID from read_lorebook.') }, required: ['entry_id'] },
    { name: 'random_keywords', kind: 'context', action: selectRandomKeywords, description: 'Select cryptographically random keywords. The result contains only space-separated selected entries.', properties: { count: { type: 'integer', minimum: 1, maximum: 100, description: 'Integer from 1 through 100.' } }, required: ['count'] },
    { name: 'set_avatar_from_attachment', kind: 'context', action: setAvatarFromAttachment, description: 'Set the current character avatar from a supported image attachment in this editor conversation.', properties: { message_id: toolString('Stable editor message ID.'), attachment_id: toolString('Stable editor attachment ID.') }, required: ['message_id', 'attachment_id'] },
];
const characterDesignerToolByName = new Map(CHARACTER_DESIGNER_TOOL_SPECS.map(tool => [tool.name, tool]));
const toolCallsOfKind = (calls, kind) => calls.filter(call => characterDesignerToolByName.get(call.name)?.kind === kind);
const LORE_ENTRY_DEFAULTS = Object.freeze({
    keys: [],
    secondary_keys: [],
    content: '',
    extensions: {},
    enabled: true,
    insertion_order: 100,
    case_sensitive: false,
    selective: false,
    constant: false,
    position: 'after_char',
});
const LORE_ENTRY_PROPERTIES = new Set(['name', 'constant', 'keys', 'content']);
const fieldById = new Map(FIELDS.map(field => [field.id, field]));
let state = null;
let workspaceAvatarUrl = null;
let workspaceLoadToken = 0;
let undo = [];
let redo = [];
let persistWarningShown = false;
let focusedEdit = null;
let resizeStart = null;
let autoSizeFrame = 0;
const pendingAutoSizes = new Map();
const autoSizeCache = new WeakMap();
let lineNumberTimer = 0;
const pendingLineNumberUpdates = new Set();
let openRenderFrame = 0;
let activeGenerationController = null;
let abortedByUser = false;
let streamRenderTimer = 0;
let lastStreamRender = 0;
let messageNavigationScrollFrame = 0;
// Reformatting a long response is linear in its length, so repaint on a fixed
// interval rather than every frame to keep that cost off the streaming loop.
const STREAM_RENDER_INTERVAL = 100;
const MESSAGE_NAVIGATION_OFFSET = 8;
const MESSAGE_NAVIGATION_TOLERANCE = 16;
// What each streaming message last put on screen, so a tick that changed nothing
// writes nothing. Keyed by the message object, which is discarded with the response.
const streamRenderCache = new WeakMap();
// Whether the transcript is still automatically following a generated message.
// Each response gets its own state so reaching its top edge is a permanent stop;
// scrolling elsewhere later must not make an already-tall response start following again.
const streamMessageAutoFollow = new WeakMap();
const pendingDiffCache = new WeakMap();
const editSummaryCache = new WeakMap();
const toolParseCache = new Map();
const historySizeCache = new WeakMap();
const reasoningToggleSync = new WeakMap();
const reasoningAutoFollow = new WeakMap();
const boundChatContainers = new WeakSet();
const boundReasoningScrollers = new WeakSet();
const REASONING_OPEN_OVERRIDE = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });
let controlsPositionFrame = 0;
const INLINE_PENDING_GAP_MAX = 8;
// One shared accept/reject pair follows the hunk under the pointer. Showing a pair
// per hunk buries the field's text once a proposal touches more than a few spots.
let activeHunk = null;
let snappedHunk = null;
let snappedEditKey = null;
// Touch has no hover: a tap fires pointerover and then pointerleave as the finger
// lifts, so tapping a hunk pins its controls until something else is tapped.
let pinnedHunk = false;
let hideControlsTimer = 0;
let cardPointer = null;
const HIDE_CONTROLS_DELAY = 220;
const messageEdit = {
    id: null,
    draft: '',
    reasoning: '',
    error: '',
    toolResultId: null,
    toolResultDraft: '',
};
let customInstructionsFocusSnapshot = null;
let activeCustomInstructionsPopup = null;
let editorLayoutObserver = null;
let fieldLineNumberObserver = null;
let attachmentTargetMessageId = null;
let uploadingAttachments = false;
let pendingExternalCardRefresh = false;

const $ = selector => document.querySelector(selector);
const deepCopy = value => structuredClone(value);
const normalizeLineEndings = value => String(value ?? '').replace(/\r\n?/g, '\n');
const currentCharacter = () => this_chid === undefined ? null : characters[this_chid] || null;
function removeLegacyWorkspaceSettings() {
    for (const key of Object.keys(accountStorage.getState())) {
        if (key.startsWith(WORKSPACE_PREFIX)) accountStorage.removeItem(key);
    }
}
const data = () => currentCharacter()?.data || currentCharacter() || {};
const isCollection = id => fieldById.get(id)?.type === 'collection';
const isNumberField = id => fieldById.get(id)?.type === 'number';
const normalizeFieldStateValue = (id, value) => isNumberField(id) ? Math.max(0, Number(value) || 0) : value;
const normalizeCardSection = value => cardSectionById.has(value) ? value : DEFAULT_CARD_SECTION;

function normalizeImageAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments
        .filter(attachment => attachment && typeof attachment.url === 'string' && attachment.url)
        .map(attachment => ({
            id: String(attachment.id || attachmentFingerprint(attachment)),
            url: attachment.url,
            title: String(attachment.title || 'Image'),
            size: Math.max(0, Number(attachment.size) || 0),
            lastModified: Math.max(0, Number(attachment.lastModified) || 0),
        }));
}
function attachmentFingerprint(attachment) {
    return `${attachment.title}\0${attachment.size}\0${attachment.lastModified}`;
}
function imageAttachmentsHtml(attachments, { editable = false } = {}) {
    const items = normalizeImageAttachments(attachments);
    if (!items.length) return '';
    return `<div class="cc-image-attachments">${items.map((attachment, index) => `
        <figure class="cc-image-attachment" data-attachment-index="${index}">
            <img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachment.title)}" title="${escapeHtml(attachment.title)}">
            ${editable ? `<button class="cc-image-attachment-delete menu_button" type="button" title="Remove ${escapeHtml(attachment.title)}" aria-label="Remove ${escapeHtml(attachment.title)}"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </figure>`).join('')}</div>`;
}
function renderDraftAttachments() {
    const container = $('#cc-editor-draft-attachments');
    if (!container) return;
    container.innerHTML = imageAttachmentsHtml(state?.draftAttachments, { editable: true });
    container.hidden = !state?.draftAttachments?.length;
    container.querySelectorAll('.cc-image-attachment-delete').forEach(button => button.addEventListener('click', () => {
        const index = Number(button.closest('.cc-image-attachment')?.dataset.attachmentIndex);
        if (!Number.isInteger(index) || !state?.draftAttachments?.[index]) return;
        record();
        state.draftAttachments.splice(index, 1);
        renderDraftAttachments();
        persist();
    }));
}
function messageForAttachmentElement(element) {
    const messageId = element.closest('.cc-message')?.dataset.messageId;
    return messageId ? getConversationMessage(messageId) : null;
}
function removeMessageAttachment(button) {
    const message = messageForAttachmentElement(button);
    const index = Number(button.closest('.cc-image-attachment')?.dataset.attachmentIndex);
    if (!message || !Number.isInteger(index) || !message.attachments?.[index] || activeGenerationController) return;
    record();
    message.attachments.splice(index, 1);
    renderChat();
    persist();
}
function openAttachmentPicker(messageId = null) {
    if (!state || activeGenerationController || uploadingAttachments) return;
    attachmentTargetMessageId = messageId;
    $('#cc-editor-image-input')?.click();
}
async function uploadImageAttachments(files, messageId = null) {
    const images = Array.from(files || []).filter(file => file instanceof File && file.type.startsWith('image/'));
    if (!images.length || !state || uploadingAttachments) return;
    const workspace = state;
    const uploadOwner = currentCharacter()?.name || 'character-card-editor';
    const target = messageId ? getConversationMessage(messageId) : null;
    if (messageId && target?.role !== 'user') return;
    uploadingAttachments = true;
    renderChat();
    try {
        const existing = normalizeImageAttachments(target ? target.attachments : state.draftAttachments);
        const fingerprints = new Set(existing.map(attachmentFingerprint));
        const uniqueFiles = images.filter(file => !fingerprints.has(`${file.name}\0${file.size}\0${file.lastModified}`));
        if (!uniqueFiles.length) return;
        const uploaded = [];
        for (const file of uniqueFiles) {
            const dataUrl = await getBase64Async(file);
            const base64 = dataUrl.split(',')[1];
            const extension = getFileExtension(file);
            const prefix = `${Date.now()}_${getStringHash(file.name)}_${uploaded.length}`;
            const url = await saveBase64AsFile(base64, uploadOwner, prefix, extension);
            uploaded.push({ id: uuidv4(), url, title: file.name, size: file.size, lastModified: file.lastModified });
        }
        if (state !== workspace) return;
        const liveTarget = messageId ? getConversationMessage(messageId) : null;
        record();
        if (messageId && liveTarget?.role === 'user') {
            liveTarget.attachments = [...normalizeImageAttachments(liveTarget.attachments), ...uploaded];
        } else if (!messageId) {
            state.draftAttachments = [...normalizeImageAttachments(state.draftAttachments), ...uploaded];
        }
        renderChat();
        renderDraftAttachments();
        persist();
    } catch (error) {
        console.error('Character card editor: could not attach image.', error);
        toastr.error('One or more images could not be attached.', 'Character card editor');
    } finally {
        uploadingAttachments = false;
        const input = $('#cc-editor-image-input');
        if (input) input.value = '';
        if (state) renderChat();
    }
}
async function promptContentWithImages(message, text) {
    const attachments = normalizeImageAttachments(message?.attachments);
    if (!attachments.length || main_api !== 'openai' || !isImageInliningSupported()) return text;
    const prepared = await Message.createAsync(message.role, text, `character-card-editor-${message.id}`);
    for (const attachment of attachments) await prepared.addImage(attachment.url);
    return prepared.content;
}

function syncEditorViewportBounds() {
    const editor = $('#character-card-editor');
    const navigation = $('#top-settings-holder');
    if (!editor || !navigation) return;

    const rect = navigation.getBoundingClientRect();
    // Custom layouts turn the normal top toolbar into a narrow left sidebar.
    // Its rendered edge is the source of truth; --sheldWidth only describes chat.
    const isLeftSidebar = rect.left <= 2 && rect.height > rect.width && rect.right < window.innerWidth;
    const sidebarWidth = isLeftSidebar ? Math.max(0, rect.right) : 0;
    editor.style.setProperty('--cc-sidebar-width', `${sidebarWidth}px`);
}

function getPath(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function setPath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    for (const key of keys) object = object[key] ||= {};
    object[last] = value;
}
function parseStoredWorkspace(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}
async function loadStoredWorkspace() {
    const avatarUrl = currentCharacter()?.avatar;
    if (!avatarUrl) return null;

    const response = await fetch('/api/character-designer/load', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    if (!response.ok) throw new Error(`Character Designer workspace load failed (${response.status})`);
    const data = await response.json();
    return parseStoredWorkspace(data.workspace);
}
function normalizeReasoningOpenOverride(value) {
    return value === REASONING_OPEN_OVERRIDE.OPEN || value === REASONING_OPEN_OVERRIDE.CLOSED ? value : null;
}
function resolveReasoningOpen(message) {
    if (message?.reasoningOpenOverride === REASONING_OPEN_OVERRIDE.OPEN) return true;
    if (message?.reasoningOpenOverride === REASONING_OPEN_OVERRIDE.CLOSED) return false;
    return true;
}
function getConversationMessage(messageId) {
    return activeConversation()?.messages.find(item => item.id === messageId) || null;
}
function bindReasoningToggle(details) {
    if (!(details instanceof HTMLDetailsElement) || details.dataset.reasoningToggleBound === 'true') return;
    details.dataset.reasoningToggleBound = 'true';
    details.addEventListener('toggle', () => {
        const suppressed = reasoningToggleSync.get(details) || 0;
        if (suppressed > 0) {
            if (suppressed === 1) reasoningToggleSync.delete(details);
            else reasoningToggleSync.set(details, suppressed - 1);
            return;
        }
        const messageId = details.closest('.cc-message')?.dataset.messageId;
        if (!messageId) return;
        const message = getConversationMessage(messageId);
        if (!message) return;
        message.reasoningOpenOverride = details.open ? REASONING_OPEN_OVERRIDE.OPEN : REASONING_OPEN_OVERRIDE.CLOSED;
        persist();
    });
    bindReasoningScroller(details.querySelector(':scope > .cc-message-reasoning-body'));
}
function setReasoningDetailsOpen(details, open) {
    if (!(details instanceof HTMLDetailsElement) || details.open === open) return;
    reasoningToggleSync.set(details, (reasoningToggleSync.get(details) || 0) + 1);
    details.open = open;
}
function reasoningLineHeight(scroller) {
    const styles = getComputedStyle(scroller);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    if (Number.isFinite(lineHeight)) return lineHeight;
    return (Number.parseFloat(styles.fontSize) || 16) * 1.35;
}
function reasoningFollowTop(scroller, revealLatest = false) {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return revealLatest ? maxScrollTop : Math.max(0, maxScrollTop - reasoningLineHeight(scroller));
}
function updateReasoningFades(scroller) {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.classList.toggle('cc-reasoning-fade-top', scroller.scrollTop > 1);
    scroller.classList.toggle('cc-reasoning-fade-bottom', scroller.scrollTop < maxScrollTop - 1);
}
function scrollReasoningIntoView(scroller, revealLatest = false) {
    scroller.scrollTo({ top: reasoningFollowTop(scroller, revealLatest), behavior: 'smooth' });
    requestAnimationFrame(() => updateReasoningFades(scroller));
}
function bindReasoningScroller(scroller) {
    if (!(scroller instanceof HTMLElement) || boundReasoningScrollers.has(scroller)) return;
    boundReasoningScrollers.add(scroller);
    reasoningAutoFollow.set(scroller, true);
    scroller.addEventListener('wheel', event => {
        if (event.deltaY < 0) reasoningAutoFollow.set(scroller, false);
    }, { passive: true });
    scroller.addEventListener('touchstart', () => reasoningAutoFollow.set(scroller, false), { passive: true });
    scroller.addEventListener('scroll', () => {
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= maxScrollTop - 1) reasoningAutoFollow.set(scroller, true);
        updateReasoningFades(scroller);
    }, { passive: true });
    requestAnimationFrame(() => updateReasoningFades(scroller));
}

function splitExamples(value) {
    const text = normalizeLineEndings(value);
    if (!text) return [];
    const parts = text.split(/(?:^|\r?\n)<START>(?:\r?\n|$)/);
    return (parts.length > 1 ? parts : [text]).filter((part, index) => part !== '' || (parts.length === 1 && index === 0));
}
function joinExamples(values) {
    return values.map(value => String(value)).filter(value => value.trim()).map(value => `<START>\n${value}`).join('\n');
}
function getValue(id) {
    const field = fieldById.get(id);
    if (id === 'greetings') return [normalizeLineEndings(data().first_mes), ...(Array.isArray(data().alternate_greetings) ? data().alternate_greetings.map(normalizeLineEndings) : [])];
    if (id === 'examples') return splitExamples(getPath(data(), field.path));
    const value = getPath(data(), field.path);
    if (id === 'depth') return normalizeFieldStateValue(id, value);
    return id === 'tags' ? (Array.isArray(value) ? value.join(', ') : String(value || '')) : normalizeLineEndings(value);
}
function setCardValue(id, value) {
    if (id === 'greetings') {
        const greetings = Array.isArray(value) && value.length ? value.map(String) : [''];
        data().first_mes = greetings[0] || '';
        data().alternate_greetings = greetings.slice(1);
        const input = $('#firstmessage_textarea');
        if (input) input.value = data().first_mes;
        return;
    }
    const field = fieldById.get(id);
    let stored = normalizeFieldStateValue(id, value);
    if (id === 'examples') stored = joinExamples(Array.isArray(value) ? value : [value]);
    if (id === 'tags') stored = String(value).split(',').map(tag => tag.trim()).filter(Boolean);
    setPath(data(), field.path, stored);
    const inputs = { description: '#description_textarea', systemPrompt: '#system_prompt_textarea', summary: '#personality_textarea', scenario: '#scenario_pole', characterNote: '#depth_prompt_prompt', postHistory: '#post_history_instructions_textarea', depth: '#depth_prompt_depth', examples: '#mes_example_textarea', createdBy: '#creator_textarea', creatorNotes: '#creator_notes_textarea', tags: '#tags_textarea', version: '#character_version_textarea' };
    const input = $(inputs[id]);
    if (input) input.value = id === 'tags' ? stored.join(', ') : String(stored ?? '');
}
function liveCharacterBook() {
    const value = data().character_book;
    return value && typeof value === 'object' && Array.isArray(value.entries) ? deepCopy(value) : null;
}
function syncLorebookToCharacterJson() {
    const character = currentCharacter();
    const input = $('#character_json_data');
    const raw = input?.value || character?.json_data;
    if (!raw) return;
    try {
        const card = typeof raw === 'string' ? JSON.parse(raw) : deepCopy(raw);
        const cardData = card?.data && typeof card.data === 'object' ? card.data : card;
        if (!cardData || typeof cardData !== 'object') return;
        if (state.lorebook) cardData.character_book = deepCopy(state.lorebook);
        else delete cardData.character_book;
        const serialized = JSON.stringify(card);
        if (input) input.value = serialized;
        if (character) character.json_data = serialized;
    } catch (error) {
        console.error('Character card editor: could not synchronize the Character Book with the card JSON.', error);
    }
}
function writeLorebookToCard() {
    if (state.lorebook) data().character_book = deepCopy(state.lorebook);
    else delete data().character_book;
    // Character saves submit the hidden full-card JSON rather than serializing the
    // live character object. Keep both representations in lockstep or the server
    // response restores the stale embedded book and invalidates pending proposals.
    syncLorebookToCharacterJson();
    saveCharacterDebounced();
}
function normalizeLoreEntry(entry = {}) {
    return { ...deepCopy(LORE_ENTRY_DEFAULTS), ...deepCopy(entry), keys: Array.isArray(entry.keys) ? entry.keys.map(String) : [], secondary_keys: Array.isArray(entry.secondary_keys) ? entry.secondary_keys.map(String) : [], extensions: entry.extensions && typeof entry.extensions === 'object' ? deepCopy(entry.extensions) : {} };
}
function createLorebook() {
    return { entries: [], extensions: {} };
}
function loreEntryIndex(entryId) {
    return state.loreEntryIds.indexOf(String(entryId || ''));
}
function loreEntry(entryId) {
    const index = loreEntryIndex(entryId);
    return index < 0 ? null : state.lorebook?.entries?.[index] || null;
}
function loreEntryLabel(entry, index = 0) {
    return String(entry?.name || entry?.comment || `Entry ${index + 1}`);
}
function lorePropertyLabel(property) {
    return String(property || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
function loreValueText(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value === undefined || value === null || value === '') return '(blank)';
    return String(value);
}
const LORE_FIELD_HELP = Object.freeze({
    name: 'A label for organizing this entry. It does not affect matching.',
    keys: 'Comma-separated trigger phrases, for example: tavern, inn, The Rusty Tankard. If any key matches recent chat text within the configured World Info scan depth, this entry activates.',
    constant: 'Always activate this entry; no key match is required.',
    content: 'Text added to the prompt when this entry activates.',
});
function setLoreProperty(object, property, value) {
    if (['enabled', 'constant'].includes(property)) value = value === true || String(value).toLowerCase() === 'true';
    if (property === 'keys') value = Array.isArray(value) ? value.map(String).filter(Boolean) : String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    object[property] = value;
}
function updateLorebookProposalAfter() {
    if (!state.lorebookProposal) return;
    state.lorebookProposal.after = deepCopy(state.lorebook);
    state.lorebookProposal.afterIds = deepCopy(state.loreEntryIds);
    if (
        JSON.stringify(state.lorebookProposal.before) === JSON.stringify(state.lorebookProposal.after) &&
        JSON.stringify(state.lorebookProposal.beforeIds) === JSON.stringify(state.lorebookProposal.afterIds)
    ) state.lorebookProposal = null;
}
function hasPersistentMessageContent(message) {
    return Boolean(
        message?.text ||
        message?.attachments?.length ||
        message?.reasoning ||
        message?.raw ||
        message?.toolXml ||
        message?.toolResult ||
        message?.toolResultDisplay ||
        message?.diffs?.length ||
        message?.errors?.length ||
        message?.error
    );
}
function normalizeConversationMessages(messages) {
    const normalized = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        message.attachments = normalizeImageAttachments(message.attachments);
        message.reasoningOpenOverride = normalizeReasoningOpenOverride(message.reasoningOpenOverride);
        const hadTransientState = Boolean(message.streaming || message.isThinking || message.toolStream);
        delete message.streaming;
        delete message.isThinking;
        delete message.toolStream;
        if (!hadTransientState || hasPersistentMessageContent(message) || message.role === 'user' || message.role === 'system') {
            normalized.push(message);
        }
    }
    return normalized;
}
function cardValuesFromCharacter() {
    return copyFieldValues(getValue);
}
function copyFieldValues(getter = liveValue) {
    return Object.fromEntries(FIELDS.map(({ id }) => [id, deepCopy(getter(id))]));
}
function flattenCardValues(value, fallback) {
    return Object.fromEntries(FIELDS.map(({ id }) => {
        const candidate = Object.hasOwn(value?.values || {}, id)
            ? value.values[id]
            : Object.hasOwn(value || {}, id)
                ? value[id]
                : value?.fields?.[id];
        const resolved = candidate ?? fallback[id];
        if (isCollection(id)) {
            const items = Array.isArray(resolved) ? resolved : [];
            return [id, items.map(normalizeLineEndings)];
        }
        if (isNumberField(id)) return [id, Math.max(0, Number(resolved) || 0)];
        return [id, normalizeLineEndings(resolved)];
    }));
}
function serializeWorkspace() {
    const saved = deepCopy(state);
    compactPendingMap(saved.pending);
    for (const checkpoint of saved.checkpoints || []) compactPendingMap(checkpoint.state?.pending);
    saved.conversations = (saved.conversations || []).map(conversation => ({
        ...conversation,
        messages: normalizeConversationMessages(conversation.messages),
    }));
    return saved;
}
function createState(saved = null) {
    const liveValues = cardValuesFromCharacter();
    const liveBook = liveCharacterBook();
    const liveFlat = flattenCardValues(liveValues, {});
    const next = saved?.version >= 2 ? saved : { pending: {}, conversations: [], activeConversation: null, checkpoints: [], draft: '', draftAttachments: [], heights: {}, cardWidth: 60 };
    next.version = 3;
    const storedLoreProposal = saved?.lorebookProposal;
    const storedProposalIsComplete = storedLoreProposal
        && Array.isArray(storedLoreProposal.beforeIds)
        && Array.isArray(storedLoreProposal.afterIds)
        && JSON.stringify(saved?.lorebook) === JSON.stringify(storedLoreProposal.after)
        && JSON.stringify(saved?.loreEntryIds) === JSON.stringify(storedLoreProposal.afterIds);
    // The card save is debounced, while proposal state is persisted immediately.
    // If a reload lands between those operations, the complete stored proposal is
    // the newer source of truth and must not be replaced by the stale server card.
    const restoredBook = storedProposalIsComplete ? deepCopy(storedLoreProposal.after) : liveBook;
    next.values = liveValues;
    delete next.fields;
    delete next.greetings;
    delete next.examples;
    next.lorebook = restoredBook;
    next.loreEntryIds = storedProposalIsComplete
        ? storedLoreProposal.afterIds.map(String)
        : Array.isArray(saved?.loreEntryIds) && saved.loreEntryIds.length === (liveBook?.entries?.length || 0)
        ? saved.loreEntryIds.map(String)
        : (liveBook?.entries || []).map(() => uuidv4());
    next.lorebookProposal = storedProposalIsComplete
        ? storedLoreProposal
        : null;
    delete next.lorebookPending;
    next.expandedLoreEntries = Array.isArray(saved?.expandedLoreEntries) ? saved.expandedLoreEntries.filter(id => next.loreEntryIds.includes(id)) : [];
    next.pending ||= {};
    for (const [id, pending] of Object.entries(next.pending)) {
        // `records` was an unused copy of every complete before/after value. Older
        // workspaces can contain megabytes of these copies in both live state and
        // every checkpoint, so discard them during migration.
        delete pending.records;
        if (isCollection(id) && pending?.operations?.some(operation => operation?.index === undefined || operation?.index === null)) {
            delete next.pending[id];
            continue;
        }
        const liveValue = next.values[id];
        const expected = pending.applied ? pending.after : pending.before;
        if (JSON.stringify(liveValue) !== JSON.stringify(expected)) delete next.pending[id];
    }
    next.conversations ||= [];
    for (const conversation of next.conversations) {
        conversation.messages = normalizeConversationMessages(conversation.messages);
        // A conversation without its own snapshots starts from the live card.
        // Existing snapshots are canonicalized too, or CRLF saved by an older
        // workspace looks like an edit to every line when compared with a textarea.
        const savedBaseline = conversation.baseline;
        const savedKnownCard = conversation.knownCard;
        conversation.baseline = flattenCardValues(savedBaseline || liveFlat, liveFlat);
        conversation.knownCard = flattenCardValues(savedKnownCard || conversation.baseline, conversation.baseline);
        conversation.baseline.__lorebook = deepCopy(savedBaseline?.__lorebook ?? next.lorebook);
        conversation.baseline.__loreEntryIds = deepCopy(savedBaseline?.__loreEntryIds ?? next.loreEntryIds);
        conversation.knownCard.__lorebook = deepCopy(savedKnownCard?.__lorebook ?? next.lorebook);
        conversation.knownCard.__loreEntryIds = deepCopy(savedKnownCard?.__loreEntryIds ?? next.loreEntryIds);
    }
    delete next.baseline;
    next.activeConversation ||= next.conversations[0]?.id || null;
    next.checkpoints = Array.isArray(next.checkpoints)
        ? next.checkpoints.slice(0, MAX_CHECKPOINTS).map(checkpoint => {
            const checkpointState = {
                ...checkpoint.state,
                values: flattenCardValues(checkpoint.state, liveFlat),
            };
            compactPendingMap(checkpointState.pending);
            delete checkpointState.fields;
            delete checkpointState.greetings;
            delete checkpointState.examples;
            return { ...checkpoint, state: checkpointState, signature: cardSignature(checkpointState) };
        })
        : [];
    trimCheckpoints(next.checkpoints);
    next.heights ||= {};
    next.cardWidth ||= 60;
    next.cardSection = normalizeCardSection(next.cardSection);
    next.cardSectionScrollTops = Object.fromEntries(CARD_SECTIONS.map(section => [
        section.id,
        Math.max(0, Number(next.cardSectionScrollTops?.[section.id]) || 0),
    ]));
    next.customInstructions = String(next.customInstructions || '');
    next.draftAttachments = normalizeImageAttachments(next.draftAttachments);
    return next;
}
function compactPendingMap(pendingMap) {
    for (const pending of Object.values(pendingMap || {})) delete pending?.records;
    return pendingMap;
}
function serializedSize(value) {
    try {
        // JavaScript strings are UTF-16; using two bytes per code unit is a safe
        // in-memory estimate and avoids allocating another full-size Uint8Array.
        return JSON.stringify(value).length * 2;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
function trimCheckpoints(checkpoints) {
    checkpoints.splice(MAX_CHECKPOINTS);
    let bytes = 0;
    let keep = 0;
    for (const checkpoint of checkpoints) {
        const size = serializedSize(checkpoint);
        if (keep && bytes + size > MAX_CHECKPOINT_BYTES) break;
        bytes += size;
        keep++;
    }
    checkpoints.splice(keep);
}
let workspaceSavePromise = Promise.resolve();
let workspaceSaveRunning = false;
let pendingWorkspaceSave = null;
function startWorkspaceSaveLoop() {
    if (workspaceSaveRunning || !pendingWorkspaceSave) return;
    workspaceSaveRunning = true;
    workspaceSavePromise = (async () => {
        while (pendingWorkspaceSave) {
            const { avatarUrl, workspace } = pendingWorkspaceSave;
            pendingWorkspaceSave = null;
            const response = await fetch('/api/character-designer/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatarUrl, workspace }),
            });
            if (!response.ok) throw new Error(`Character Designer workspace save failed (${response.status})`);
            persistWarningShown = false;
        }
    })().catch(error => {
        console.error('Character card editor: could not persist the workspace.', error);
        if (!persistWarningShown) {
            persistWarningShown = true;
            toastr.error('Editor changes could not be saved to the Character Designer workspace file.', 'Character card editor');
        }
    }).finally(() => {
        workspaceSaveRunning = false;
        startWorkspaceSaveLoop();
    });
}
function persistWorkspace() {
    if (!state || !workspaceAvatarUrl) return workspaceSavePromise;
    // Capture state and its owning avatar together. The user may switch characters
    // before an older request completes, but that must never retarget this payload.
    pendingWorkspaceSave = { avatarUrl: workspaceAvatarUrl, workspace: serializeWorkspace() };
    startWorkspaceSaveLoop();
    return workspaceSavePromise;
}
const persist = debounce(persistWorkspace, 500);
function snapshot() { return deepCopy({ values: state.values, lorebook: state.lorebook, loreEntryIds: state.loreEntryIds, lorebookProposal: state.lorebookProposal, expandedLoreEntries: state.expandedLoreEntries, pending: state.pending, conversations: state.conversations, activeConversation: state.activeConversation, draft: state.draft, draftAttachments: state.draftAttachments, heights: state.heights, cardWidth: state.cardWidth, customInstructions: state.customInstructions }); }
function snapshotSize(value) {
    if (!value || typeof value !== 'object') return 0;
    if (!historySizeCache.has(value)) historySizeCache.set(value, serializedSize(value));
    return historySizeCache.get(value);
}
function pushHistory(stack, value) {
    stack.push(value);
    let bytes = stack.reduce((total, entry) => total + snapshotSize(entry), 0);
    while (stack.length > MAX_HISTORY || (stack.length > 1 && bytes > MAX_HISTORY_BYTES)) {
        bytes -= snapshotSize(stack.shift());
    }
}
function record(value = snapshot()) {
    pushHistory(undo, value);
    redo = [];
    return value;
}
function compactSignature(value) { return String(getStringHash(JSON.stringify(value))); }
function snapshotSignature(value) { return compactSignature([value.values, value.lorebook, value.loreEntryIds, value.lorebookProposal, value.pending, value.conversations, value.customInstructions]); }
// A checkpoint only ever restores card state, so it deliberately drops the conversation
// history. Keeping it would store MAX_CHECKPOINTS copies of every message and reasoning
// trace beside the live workspace file.
function cardSnapshot(value) { return { values: value?.values, lorebook: value?.lorebook, loreEntryIds: value?.loreEntryIds, lorebookProposal: value?.lorebookProposal, expandedLoreEntries: value?.expandedLoreEntries, pending: value?.pending }; }
function cardSignature(value) { return compactSignature([value.values, value.lorebook, value.loreEntryIds, value.lorebookProposal, value.pending]); }
/** @param {{signature?: string}} [options] `signature` must come from cardSignature, not snapshotSignature. */
function checkpoint(label, value = snapshot(), content = '', { signature = null } = {}) {
    // Always copied, never aliased: `value` is usually the caller's undo entry, and a
    // checkpoint has to keep reading the card as it was even after that entry is restored.
    const saved = deepCopy(cardSnapshot(value));
    const savedSignature = signature ?? cardSignature(saved);
    if (state.checkpoints[0]?.signature === savedSignature) return;
    state.checkpoints.unshift({ id: uuidv4(), created: Date.now(), label, content: String(content || ''), signature: savedSignature, state: saved });
    trimCheckpoints(state.checkpoints);
    // Destructive boundaries are deliberately persisted immediately so a crash
    // after the following mutation still leaves a recovery point.
    persistWorkspace();
}
function changeContent(removed, added) {
    const sections = [];
    if (removed) sections.push(`Removed:\n${removed}`);
    if (added) sections.push(`Added:\n${added}`);
    return sections.join('\n\n') || '(blank)';
}
function backupContentHtml(content) {
    const chunks = String(content || '').split(/\n\n(?=(?:Removed|Added):\n)/);
    return chunks.map(chunk => {
        if (chunk.startsWith('Removed:\n')) return `<span class="cc-backup-remove">\u2212 ${escapeHtml(chunk.slice(9))}</span>`;
        if (chunk.startsWith('Added:\n')) return `<span class="cc-backup-add">+ ${escapeHtml(chunk.slice(7))}</span>`;
        return `<span>${escapeHtml(chunk)}</span>`;
    }).join('');
}
function writeWorkspaceToCard() {
    for (const { id } of FIELDS) setCardValue(id, state.values[id]);
    writeLorebookToCard();
    saveCharacterDebounced();
}
function workspaceMatchesCard() {
    return FIELDS.every(({ id }) => JSON.stringify(state.values[id]) === JSON.stringify(getValue(id)))
        && JSON.stringify(state.lorebook) === JSON.stringify(liveCharacterBook());
}
function restoreSnapshot(next) { Object.assign(state, deepCopy(next)); writeWorkspaceToCard(); render(); persist(); }
function customInstructionsValue() { return String(state?.customInstructions || ''); }
function isCustomInstructionsOpen() { return Boolean(activeCustomInstructionsPopup); }
async function closeCustomInstructionsPopup({ restoreFocus = false } = {}) {
    const button = $('#cc-editor-custom-instructions-button');
    const popup = activeCustomInstructionsPopup;
    if (!popup || !button) return;
    activeCustomInstructionsPopup = null;
    await popup.completeCancelled();
    if (restoreFocus) button.focus();
}
async function openCustomInstructionsPopup() {
    if (!state) return;
    const button = $('#cc-editor-custom-instructions-button');
    if (!button) return;
    customInstructionsFocusSnapshot ||= snapshot();
    const content = document.createElement('div');
    content.className = 'cc-editor-custom-instructions-popup';
    content.innerHTML = `<h3>Custom Instructions</h3><p>Applied to every editor reply. Use this for rules like "don't make edits until I say so."</p><textarea id="cc-editor-custom-instructions-input" class="text_pole" rows="12" placeholder="Optional instructions for the editor model..."></textarea>`;
    const input = content.querySelector('#cc-editor-custom-instructions-input');
    input.value = customInstructionsValue();
    input.addEventListener('input', event => commitCustomInstructions(event.target.value));
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => {
            button.setAttribute('aria-expanded', 'true');
            requestAnimationFrame(() => {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            });
        },
        onClose: () => {
            button.setAttribute('aria-expanded', 'false');
            if (customInstructionsFocusSnapshot) {
                const before = customInstructionsFocusSnapshot;
                customInstructionsFocusSnapshot = null;
                if (snapshotSignature(before) !== snapshotSignature(snapshot())) {
                    pushHistory(undo, before);
                    redo = [];
                }
            }
            activeCustomInstructionsPopup = null;
            renderCustomInstructions();
        },
    });
    // DISPLAY popups do not close from their backdrop by default. Treat a click
    // on the native dialog backdrop target like the close button.
    popup.dlg.addEventListener('click', event => {
        if (event.target === popup.dlg) void closeCustomInstructionsPopup();
    });
    activeCustomInstructionsPopup = popup;
    await popup.show();
}
async function toggleCustomInstructionsPopup() {
    if (isCustomInstructionsOpen()) await closeCustomInstructionsPopup({ restoreFocus: true });
    else await openCustomInstructionsPopup();
}
function renderCustomInstructions() {
    const button = $('#cc-editor-custom-instructions-button');
    if (!button) return;
    const active = Boolean(customInstructionsValue().trim());
    button.disabled = !state;
    button.classList.toggle('active', active);
    button.title = `${active ? 'Edit' : 'Add'} editor custom instructions`;
}
function commitCustomInstructions(value) {
    if (!state) return;
    state.customInstructions = String(value ?? '');
    renderCustomInstructions();
    persist();
}
function fieldLabel(id, index = null) {
    const label = fieldById.get(id)?.label || id;
    if (!isCollection(id) || index === null) return label;
    return `${id === 'examples' ? 'Example' : 'Greeting'} ${Number(index) + 1}`;
}
function collectionItemValue(values, index) {
    return String(Array.isArray(values) ? values[Number(index)] ?? '' : '');
}
function activeConversation() { return state.conversations.find(conversation => conversation.id === state.activeConversation) || null; }
function currentCardValues() {
    return { ...copyFieldValues(), __lorebook: deepCopy(state.lorebook), __loreEntryIds: deepCopy(state.loreEntryIds) };
}
function initializeConversationCardState(conversation) {
    const current = currentCardValues();
    conversation.baseline = deepCopy(current);
    conversation.knownCard = deepCopy(current);
    delete conversation.pendingCardState;
    return conversation;
}
function ensureConversation() {
    let conversation = activeConversation();
    if (!conversation) {
        conversation = initializeConversationCardState({ id: uuidv4(), created: Date.now(), messages: [] });
        state.conversations.unshift(conversation);
        state.activeConversation = conversation.id;
    }
    return conversation;
}
function effectiveValue(id) { return state.pending[id]?.after ?? state.values[id]; }
function liveValue(id) { return state.values[id]; }
function autoSize(element, manual = false) {
    if (!(element instanceof HTMLTextAreaElement)) return;
    pendingAutoSizes.set(element, manual);
    if (autoSizeFrame) return;
    autoSizeFrame = requestAnimationFrame(() => {
        autoSizeFrame = 0;
        const queued = [...pendingAutoSizes]
            .filter(([textarea]) => textarea.isConnected)
            .filter(([textarea, isManual]) => {
                const key = `${textarea.value}\0${textarea.clientWidth}\0${isManual}\0${window.innerHeight}`;
                const cached = autoSizeCache.get(textarea);
                // morphdom keeps the textarea node but removes its runtime inline
                // height when the freshly rendered markup has no style attribute.
                // A value/width-only cache hit would then leave it at the CSS
                // one-line minimum until the user types or changes sections.
                return cached?.key !== key
                    || cached.height !== textarea.style.height
                    || cached.overflowY !== textarea.style.overflowY;
            });
        pendingAutoSizes.clear();
        if (!queued.length) return;
        const scrollers = new Map();
        for (const [textarea] of queued) {
            // A card textarea can have two independently scrolling ancestors: its
            // capped code-field wrapper and the complete card pane. Resizing after a
            // newline briefly collapses the textarea and can reset either ancestor.
            for (const scroller of [
                textarea.closest('.cc-code-field'),
                textarea.closest('.cc-editor-card, .cc-editor-messages'),
            ]) {
                if (scroller && !scrollers.has(scroller)) scrollers.set(scroller, scroller.scrollTop);
            }
        }
        // Reset all heights before measuring. Keeping reads and writes in separate
        // phases prevents one textarea's height from invalidating every later read.
        queued.forEach(([textarea]) => { textarea.style.height = 'auto'; textarea.style.overflowY = 'hidden'; });
        const measurements = queued.map(([textarea, isManual]) => {
            // The field wrapper caps and scrolls the complete editor (gutter and
            // text together). Keep the textarea itself at its full content height.
            const logicalCap = textarea.classList.contains('cc-field-input')
                ? Number.POSITIVE_INFINITY
                : isManual ? Math.floor(window.innerHeight * .95) : MAX_FIELD_HEIGHT();
            // Some controls (notably the composer) have a smaller CSS max-height
            // than the general editor cap. Use the rendered cap so overflow is
            // enabled as soon as CSS stops the textarea from growing.
            const cssCap = Number.parseFloat(getComputedStyle(textarea).maxHeight);
            const cap = Number.isFinite(cssCap) ? Math.min(logicalCap, cssCap) : logicalCap;
            const key = `${textarea.value}\0${textarea.clientWidth}\0${isManual}\0${window.innerHeight}`;
            return { textarea, cap, key, scrollHeight: textarea.scrollHeight };
        });
        measurements.forEach(({ textarea, cap, key, scrollHeight }) => {
            // Preserve the composer's intended one-line height.
            const minimumHeight = textarea.id === 'cc-editor-composer' ? 36 : 28;
            textarea.style.height = `${Math.min(Math.max(scrollHeight, minimumHeight), cap)}px`;
            textarea.style.overflowY = scrollHeight > cap ? 'auto' : 'hidden';
            autoSizeCache.set(textarea, {
                key,
                height: textarea.style.height,
                overflowY: textarea.style.overflowY,
            });
        });
        // Measuring a long textarea briefly changes its layout height. Firefox may
        // otherwise move the pane's scroll anchor during that read/write cycle.
        for (const [scroller, scrollTop] of scrollers) scroller.scrollTop = scrollTop;
        // A freshly rendered tab sizes its textareas on this frame. Measure wrapped
        // line geometry only after those heights are final; otherwise the initial
        // timer and ResizeObserver race and the gutter visibly corrects itself later.
        for (const { textarea } of measurements) {
            if (textarea.classList.contains('cc-field-input') && textarea.dataset.lineNumbersReady !== 'true') {
                pendingLineNumberUpdates.add(textarea);
                syncLineNumberCount(textarea);
                textarea.dataset.lineNumbersReady = 'true';
            }
        }
        if (pendingLineNumberUpdates.size) {
            clearTimeout(lineNumberTimer);
            flushLineNumberUpdates();
        }
    });
}
function asText(value) { return Array.isArray(value) ? value.join('\n\n') : String(value ?? ''); }
function lineNumberGutter(value) {
    const lineCount = Math.max(1, normalizeLineEndings(value).split('\n').length);
    const numbers = Array.from({ length: lineCount }, (_, index) => `<span>${index + 1}</span>`).join('');
    return `<div class="cc-line-numbers" aria-hidden="true">${numbers}</div>`;
}
function fieldEditorValue(input) {
    return input instanceof HTMLTextAreaElement ? input.value : input.innerText.replaceAll('\r\n', '\n');
}
function measureWrappedLineHeights(input, lines) {
    if (!input.clientWidth) return null;
    const style = getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.6;
    // Use the browser's textarea wrapping algorithm instead of estimating glyph
    // widths. Markdown punctuation, tabs, whitespace, and word-boundary wrapping
    // can all produce a different row count than a canvas-width approximation.
    const measurementRoot = document.createElement('div');
    measurementRoot.setAttribute('aria-hidden', 'true');
    Object.assign(measurementRoot.style, {
        position: 'fixed',
        left: '-100000px',
        top: '0',
        width: '0',
        height: '0',
        overflow: 'hidden',
        visibility: 'hidden',
        pointerEvents: 'none',
    });
    const mirrors = lines.map(line => {
        const mirror = document.createElement('textarea');
        mirror.wrap = 'soft';
        mirror.tabIndex = -1;
        mirror.value = line || ' ';
        Object.assign(mirror.style, {
            boxSizing: 'border-box',
            display: 'block',
            width: `${input.clientWidth}px`,
            height: '0',
            minHeight: '0',
            maxHeight: 'none',
            margin: '0',
            padding: `0 ${style.paddingRight} 0 ${style.paddingLeft}`,
            border: '0',
            overflow: 'hidden',
            resize: 'none',
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
            font: style.font,
            letterSpacing: style.letterSpacing,
            lineHeight: style.lineHeight,
            tabSize: style.tabSize,
        });
        measurementRoot.append(mirror);
        return mirror;
    });
    document.body.append(measurementRoot);
    const heights = mirrors.map(mirror => Math.max(lineHeight, mirror.scrollHeight));
    measurementRoot.remove();
    return heights;
}
function syncLineNumberCount(input) {
    const gutter = input.closest('.cc-field-body')?.querySelector('.cc-line-numbers');
    if (!gutter) return null;
    const lines = normalizeLineEndings(fieldEditorValue(input)).split('\n');
    const lineCount = Math.max(1, lines.length);
    if (gutter.childElementCount !== lineCount) {
        const scroller = input.closest('.cc-code-field');
        const scrollTop = scroller?.scrollTop;
        while (gutter.childElementCount < lineCount) {
            const number = document.createElement('span');
            number.textContent = String(gutter.childElementCount + 1);
            gutter.append(number);
        }
        while (gutter.childElementCount > lineCount) gutter.lastElementChild.remove();
        // Updating the grid sibling changes its intrinsic height. Keep the viewport
        // stable instead of letting that reflow move a long field back to its start.
        if (scroller) scroller.scrollTop = scrollTop;
    }
    return { input, gutter, lines };
}
function flushLineNumberUpdates() {
    lineNumberTimer = 0;
    const entries = [...pendingLineNumberUpdates]
        .filter(input => input.isConnected)
        .map(syncLineNumberCount)
        .filter(Boolean)
        .map(entry => ({ ...entry, heights: measureWrappedLineHeights(entry.input, entry.lines) || [] }));
    pendingLineNumberUpdates.clear();
    const scrollers = new Map();
    for (const { input } of entries) {
        const scroller = input.closest('.cc-code-field');
        if (scroller && !scrollers.has(scroller)) scrollers.set(scroller, scroller.scrollTop);
    }
    for (const { gutter, heights } of entries) {
        [...gutter.children].forEach((number, index) => {
            number.style.height = heights[index] ? `${heights[index]}px` : '';
        });
    }
    for (const [scroller, scrollTop] of scrollers) scroller.scrollTop = scrollTop;
}
function scheduleLineNumberUpdate(input, { immediate = false } = {}) {
    if (!(input instanceof HTMLElement)) return;
    pendingLineNumberUpdates.add(input);
    // Keep the inexpensive logical line count current while typing. Wrapped-line
    // geometry waits for a short pause, avoiding a full DOM measurement per key.
    syncLineNumberCount(input);
    clearTimeout(lineNumberTimer);
    lineNumberTimer = setTimeout(flushLineNumberUpdates, immediate ? 0 : 80);
}
function diffIsPending(diff) {
    const current = state.pending[diff.field];
    if (!current) return false;
    const unresolved = pendingDiffParts(current).filter(part => part.type === 'hunk');
    return pendingDiffParts(diff)
        .filter(part => part.type === 'hunk')
        .some(proposed => unresolved.some(part => part.removed === proposed.removed && part.added === proposed.added));
}
function diffHtml(pending) {
    if (pending.lorebook) {
        const unresolved = Boolean(state.lorebookProposal);
        const content = `<span>${escapeHtml(lorebookChangeSummary(pending))}</span>`;
        if (!unresolved) return `<div class="cc-diff-jump cc-diff-resolved">${content}</div>`;
        return `<button class="cc-diff-jump" data-lorebook type="button">${content}</button>`;
    }
    const proposals = pending.operations?.length ? pending.operations : [{ label: fieldById.get(pending.field)?.label || pending.field, find: asText(pending.before), replace: asText(pending.after) }];
    const content = proposals.map(proposalDiffHtml).join('');
    if (!diffIsPending(pending)) return `<div class="cc-diff-jump cc-diff-resolved">${content}</div>`;
    return `<button class="cc-diff-jump" data-field="${pending.field}" type="button">${content}</button>`;
}
function compactToolText(value, emptyText) {
    const text = String(value ?? '');
    if (!text) return emptyText;
    const firstLine = text.split('\n')[0];
    return firstLine + (text.includes('\n') ? '…' : '');
}
function proposalDiffHtml(proposal) {
    if (proposal?.operation === 'insert') return `<span class="cc-add">+ ${escapeHtml(compactToolText(proposal.content, 'empty'))}</span>`;
    if (proposal?.operation === 'delete-span') {
        const from = compactToolText(proposal.from, 'empty');
        const until = compactToolText(proposal.until, 'empty');
        return `<span class="cc-remove">- ${escapeHtml(`${from} … before ${until}`)}</span>`;
    }
    const replace = compactToolText(proposal?.replace, 'empty');
    const find = compactToolText(proposal?.find, 'empty');
    return `<span class="cc-remove">- ${escapeHtml(find)}</span><span class="cc-add">+ ${escapeHtml(replace)}</span>`;
}
function failedEditHtml(error) {
    const hasVisibleProposal = error?.proposal && (
        error.proposal.operation === 'insert' ||
        error.proposal.operation === 'delete-span' ||
        Object.hasOwn(error.proposal, 'find') ||
        Object.hasOwn(error.proposal, 'replace')
    );
    const proposal = hasVisibleProposal ? `<div class="cc-failed-diff">${proposalDiffHtml(error.proposal)}</div>` : '';
    return `${proposal}<div class="cc-tool-error-text">${escapeHtml(error?.detail || error?.message || 'The tool call could not be validated.')}</div>`;
}
function joinedLabels(labels) {
    const unique = [...new Set(labels.map(label => String(label || '').trim()).filter(Boolean))];
    if (unique.length < 2) return unique[0] || '';
    if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
    return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`;
}
function toolCallSummaryText(text) {
    const reads = [];
    const edits = [];
    const contextActions = [];
    for (const call of parseCharacterDesignerToolCalls(text).calls.filter(call => !call.error)) {
        if (call.name === 'random_keywords') { contextActions.push('Selected random keywords'); continue; }
        if (call.name === 'set_avatar_from_attachment') { contextActions.push('Set the avatar'); continue; }
        const rawLabel = String(call.args.field || '').trim();
        const label = call.name.includes('lorebook') ? 'Character Book' : resolveToolField(rawLabel)?.label || rawLabel || 'an unknown section';
        (call.name.startsWith('read_') ? reads : edits).push(label);
    }
    const actions = [];
    if (reads.length) actions.push(`Read ${joinedLabels(reads)}`);
    if (edits.length) actions.push(`Edited ${joinedLabels(edits)}`);
    actions.push(...contextActions);
    if (!actions.length) return 'Using card tools\u2026';
    return `${actions.join('; ')}.`;
}
function toolCallSummaryHtml(message) {
    if (!message.toolXml) return '';
    return `<div class="cc-tool-call-summary"><i class="fa-solid fa-wrench" aria-hidden="true"></i><span>${escapeHtml(toolCallSummaryText(message.toolXml))}</span></div>`;
}
function streamingToolHtml(text) {
    return `<div class="cc-tool-stream"><i class="fa-solid fa-wrench" aria-hidden="true"></i><span>${escapeHtml(toolCallSummaryText(text))}</span></div>`;
}
function streamedToolText(text, toolParse = null) {
    const source = String(text || '');
    const firstCall = (toolParse || parseCharacterDesignerToolCalls(source)).calls[0];
    return firstCall ? source.slice(firstCall.start) : '';
}
function streamedProse(text, toolParse = null) {
    const source = String(text || '');
    const scopedTools = toolParse || parseCharacterDesignerToolCalls(source);
    const firstCall = scopedTools.calls[0];
    if (firstCall) return source.slice(0, firstCall.start).trim();
    return scopedTools.parsed.segments
        .filter(segment => segment.type === 'text')
        .map(segment => segment.text)
        .join('')
        .trim();
}
function collectionControl(id) {
    const pending = state.pending[id];
    const values = Array.isArray(effectiveValue(id)) ? effectiveValue(id) : [];
    const beforeValues = Array.isArray(pending?.before) ? pending.before : [];
    const singular = id === 'examples' ? 'Example' : 'Greeting';
    const count = Math.max(values.length, beforeValues.length, id === 'greetings' ? 1 : 0);
    return `<div class="cc-collection">${Array.from({ length: count }, (_, index) => {
        const value = collectionItemValue(values, index);
        const beforeValue = collectionItemValue(beforeValues, index);
        const body = pending && beforeValue !== value
            ? `<div class="cc-field-body cc-code-field has-pending" data-field="${id}" data-index="${index}">${lineNumberGutter(value)}${pendingFieldControl({ field: id, before: beforeValue, after: value }, { index })}</div>`
            : `<div class="cc-field-body cc-code-field">${lineNumberGutter(value)}<textarea class="text_pole cc-field-input" data-field="${id}" data-index="${index}" rows="1" wrap="soft">${escapeHtml(value)}</textarea></div>`;
        return `<div class="cc-collection-row"><div class="cc-collection-row-header"><span>${fieldLabel(id, index)}</span><div class="cc-collection-controls"><button class="cc-delete menu_button menu_button_icon" data-collection-action="delete" title="Delete ${singular.toLowerCase()}" type="button"><i class="fa-solid fa-trash-can"></i></button></div></div>${body}</div>`;
    }).join('')}</div>`;
}
function valueFromText(id, text) {
    if (!isCollection(id)) return text;
    return id === 'examples' ? splitExamples(text) : [text];
}
function isInlinePendingGap(text) {
    return typeof text === 'string' && text.length > 0 && text.length <= INLINE_PENDING_GAP_MAX && !/\s/.test(text);
}
function createUiDiffer() {
    const dmp = new DiffMatchPatch();
    // A render must never monopolize the main thread for diff-match-patch's
    // one-second default deadline. Its timeout fallback is still a valid (coarser)
    // diff, and the result is cached below for the lifetime of the values.
    dmp.Diff_Timeout = DIFF_TIMEOUT_SECONDS;
    return dmp;
}
function pendingDiffParts(pending) {
    const beforeText = asText(pending.before);
    const afterText = asText(pending.after);
    const cached = pending && typeof pending === 'object' ? pendingDiffCache.get(pending) : null;
    if (cached?.before === beforeText && cached?.after === afterText) return cached.parts;
    const dmp = createUiDiffer();
    const diffs = dmp.diff_main(beforeText, afterText);
    // Collapse incidental character matches inside a replacement so the UI
    // presents meaningful word/phrase changes instead of fragmented letters.
    dmp.diff_cleanupSemantic(diffs);
    const rawParts = [];
    let beforePosition = 0;
    let afterPosition = 0;
    let hunk = null;
    const finishHunk = () => {
        if (!hunk) return;
        hunk.beforeEnd = beforePosition;
        hunk.afterEnd = afterPosition;
        rawParts.push(hunk);
        hunk = null;
    };
    for (const [operation, text] of diffs) {
        if (operation === 0) {
            finishHunk();
            rawParts.push({ type: 'equal', text });
            beforePosition += text.length;
            afterPosition += text.length;
            continue;
        }
        hunk ||= { type: 'hunk', beforeStart: beforePosition, afterStart: afterPosition, removed: '', added: '' };
        if (operation < 0) { hunk.removed += text; beforePosition += text.length; }
        else { hunk.added += text; afterPosition += text.length; }
    }
    finishHunk();
    const parts = [];
    let mergedHunk = null;
    let pendingGap = null;
    let hunkIndex = 0;
    const pushMergedHunk = () => {
        if (!mergedHunk) return;
        parts.push({
            type: 'hunk',
            beforeStart: mergedHunk.beforeStart,
            afterStart: mergedHunk.afterStart,
            beforeEnd: mergedHunk.beforeEnd,
            afterEnd: mergedHunk.afterEnd,
            removed: beforeText.slice(mergedHunk.beforeStart, mergedHunk.beforeEnd),
            added: afterText.slice(mergedHunk.afterStart, mergedHunk.afterEnd),
            index: hunkIndex++,
        });
        mergedHunk = null;
    };
    for (const part of rawParts) {
        if (part.type === 'equal') {
            if (mergedHunk && isInlinePendingGap(part.text)) {
                pendingGap = part;
                continue;
            }
            pushMergedHunk();
            if (pendingGap) {
                parts.push(pendingGap);
                pendingGap = null;
            }
            parts.push(part);
            continue;
        }
        if (!mergedHunk) {
            mergedHunk = { ...part };
            pendingGap = null;
            continue;
        }
        mergedHunk.beforeEnd = part.beforeEnd;
        mergedHunk.afterEnd = part.afterEnd;
        pendingGap = null;
    }
    pushMergedHunk();
    if (pendingGap) parts.push(pendingGap);
    if (pending && typeof pending === 'object') pendingDiffCache.set(pending, { before: beforeText, after: afterText, parts });
    return parts;
}
function lineAt(text, position) {
    return String(text).slice(0, position).split('\n').length - 1;
}
function changedCardSections(before = {}, after = {}) {
    const sections = [];
    for (const { id } of FIELDS) {
        const beforeValue = before[id];
        const afterValue = after[id];
        if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
        if (!isCollection(id)) {
            sections.push({ id, label: fieldLabel(id), before: asText(beforeValue), after: asText(afterValue) });
            continue;
        }
        const oldItems = Array.isArray(beforeValue) ? beforeValue : [];
        const newItems = Array.isArray(afterValue) ? afterValue : [];
        const count = Math.max(oldItems.length, newItems.length);
        for (let index = 0; index < count; index++) {
            const oldItem = String(oldItems[index] ?? '');
            const newItem = String(newItems[index] ?? '');
            if (oldItem === newItem && index < oldItems.length && index < newItems.length) continue;
            const operation = index >= oldItems.length ? 'added' : index >= newItems.length ? 'removed' : 'changed';
            sections.push({ id, index, label: fieldLabel(id, index), before: oldItem, after: newItem, operation });
        }
    }
    return sections;
}
function whitespaceSummary(text) {
    const names = new Map([[' ', 'space'], ['\t', 'tab'], ['\r', 'carriage return'], ['\n', 'line feed']]);
    const counts = new Map();
    for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
    return [...counts].map(([character, count]) => `${count} ${names.get(character) || 'whitespace character'}${count === 1 ? '' : 's'}`).join(', ');
}
function changeValueXml(tag, value) {
    const text = String(value ?? '');
    if (!text) return '';
    const whitespace = /^\s+$/.test(text)
        ? ` whitespace="${xmlText(whitespaceSummary(text))}"`
        : '';
    return `<${tag} characters="${characterCount(text)}"${whitespace}>${xmlText(text)}</${tag}>`;
}
function cardChangesText(sections) {
    const details = sections.flatMap(section => {
        const hunks = pendingDiffParts(section).filter(part => part.type === 'hunk');
        const changes = hunks.length
            ? hunks.map(part => changeContent(part.removed, part.added))
            : [changeContent(section.before, section.after)];
        return changes.filter(Boolean).map(change => `**${section.label}**\n${change}`);
    });
    return [`Card changed outside this conversation: ${joinedLabels(sections.map(section => section.label))}.`, ...details].join('\n\n');
}
function cardChangesContext(sections) {
    const changeXml = (section, beforeLine, afterLine, removed, added) => [
        '<change>',
        `<field>${xmlText(section.label)}</field>`,
        section.operation ? `<operation>${section.operation}</operation>` : '',
        `<before_line>${beforeLine}</before_line>`,
        `<after_line>${afterLine}</after_line>`,
        changeValueXml('removed', removed),
        changeValueXml('added', added),
        '</change>',
    ].filter(Boolean).join('\n');
    const changes = sections.flatMap(section => {
        const hunks = pendingDiffParts(section).filter(part => part.type === 'hunk');
        if (!hunks.length) {
            return [changeXml(section, 0, 0, section.before, section.after)];
        }
        return hunks.map(part => changeXml(
            section,
            lineAt(section.before, part.beforeStart),
            lineAt(section.after, part.afterStart),
            part.removed,
            part.added,
        ));
    });
    return truncateCardChangeContext(`<card_changes>\n${changes.join('\n')}\n</card_changes>`);
}
function truncateCardChangeContext(context) {
    const characters = Array.from(String(context || ''));
    if (characters.length <= MAX_CARD_CHANGE_CONTEXT_LENGTH) return characters.join('');
    const suffix = Array.from(CARD_CHANGE_TRUNCATION_SUFFIX);
    return `${characters.slice(0, MAX_CARD_CHANGE_CONTEXT_LENGTH - suffix.length).join('')}${CARD_CHANGE_TRUNCATION_SUFFIX}`;
}
function detectConversationCardChanges(conversation = activeConversation()) {
    if (!conversation?.knownCard) return [];
    const current = currentCardValues();
    const sections = changedCardSections(conversation.knownCard, current);
    if (sections.length) conversation.pendingCardState = current;
    else delete conversation.pendingCardState;
    return sections;
}
function appendPendingCardChangeNotice(conversation) {
    const sections = detectConversationCardChanges(conversation);
    if (!sections.length) return false;
    conversation.messages.push({
        id: uuidv4(),
        role: 'system',
        type: 'card-change',
        text: cardChangesText(sections),
        cardChangeContext: cardChangesContext(sections),
    });
    conversation.knownCard = deepCopy(conversation.pendingCardState);
    delete conversation.pendingCardState;
    return true;
}
function updateKnownCardFields(conversation, fields) {
    if (!conversation?.knownCard) return;
    for (const id of new Set(fields.filter(id => fieldById.has(id)))) {
        conversation.knownCard[id] = deepCopy(liveValue(id));
    }
    detectConversationCardChanges(conversation);
}
function pendingFieldControl(pending, { index = null } = {}) {
    const dataIndex = index === null ? '' : ` data-index="${index}"`;
    const content = pendingDiffParts(pending).map(part => {
        // Equal text needs no element of its own. Large edits can contain hundreds
        // of equal runs, and wrapping every one makes each style invalidation walk
        // a much larger tree while the proposal is pending.
        if (part.type === 'equal') return escapeHtml(part.text);
        const removed = part.removed ? ` data-removed="${escapeHtml(part.removed)}"` : '';
        return `<span class="cc-pending-change cc-pending-hunk" data-hunk="${part.index}"${removed}><span class="cc-add cc-pending-add">${escapeHtml(part.added)}</span></span>`;
    }).join('');
    return `<div class="text_pole cc-field-input cc-pending-field" data-field="${pending.field}"${dataIndex} contenteditable="plaintext-only" spellcheck="true">${content}</div>`;
}
function lorePropertyText(property, value) {
    if (property === 'keys') return Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (property === 'constant') return value ? 'Yes' : 'No';
    return String(value ?? '');
}
function lorePendingChange(entryId, property) {
    const proposal = state.lorebookProposal;
    if (!proposal) return null;
    const beforeIndex = proposal.beforeIds?.indexOf(entryId) ?? -1;
    const afterIndex = state.loreEntryIds.indexOf(entryId);
    if (beforeIndex < 0 || afterIndex < 0) return null;
    const before = lorePropertyText(property, proposal.before?.entries?.[beforeIndex]?.[property]);
    const after = lorePropertyText(property, state.lorebook?.entries?.[afterIndex]?.[property]);
    return before === after ? null : { field: property, before, after };
}
function lorePendingControl(entryId, property, pending, { editable = true, className = '', tag = 'div' } = {}) {
    const content = pendingDiffParts(pending).map(part => {
        if (part.type === 'equal') return escapeHtml(part.text);
        const removed = part.removed ? ` data-removed="${escapeHtml(part.removed)}"` : '';
        return `<span class="cc-pending-change cc-pending-hunk" data-hunk="${part.index}"${removed}><span class="cc-add cc-pending-add">${escapeHtml(part.added)}</span></span>`;
    }).join('');
    const editableAttributes = editable ? ' contenteditable="plaintext-only" spellcheck="true"' : '';
    return `<${tag} class="text_pole cc-pending-field cc-lore-pending-field ${className}" data-lore-entry="${escapeHtml(entryId)}" data-lore-property="${property}"${editableAttributes}>${content}</${tag}>`;
}
function removeFloatingHunkControls() {
    cancelAnimationFrame(controlsPositionFrame);
    controlsPositionFrame = 0;
    cancelHunkControlsHide();
    activeHunk = null;
    snappedHunk = null;
    pinnedHunk = false;
    document.querySelectorAll('.cc-floating-hunk-controls').forEach(element => element.remove());
}
function visibleHunkRect(hunk, cardRect) {
    for (const element of [hunk, ...hunk.querySelectorAll('.cc-remove, .cc-add')]) {
        // The union of an element's line boxes rules out all of its fragments at the
        // cost of one rect, so hunks scrolled out of view never enumerate them.
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom <= cardRect.top || bounds.top >= cardRect.bottom) continue;
        for (const rect of element.getClientRects()) {
            if (rect.width > 1 && rect.bottom > cardRect.top && rect.top < cardRect.bottom) return rect;
        }
    }
    return null;
}
function performPendingControlsPosition() {
    controlsPositionFrame = 0;
    const controls = document.querySelector('.cc-floating-hunk-controls');
    if (!controls) return;
    // The editor can be closed by any drawer the app opens, not just its own toggle,
    // so the open state is checked here rather than trusted from a close handler.
    const open = $('#character-card-editor')?.classList.contains('openDrawer');
    const cardRect = open ? $('#cc-editor-card')?.getBoundingClientRect() : null;
    const hunkRect = cardRect?.width && activeHunk?.isConnected ? visibleHunkRect(activeHunk, cardRect) : null;
    // Writing an unchanged value still dirties style, so only touch what moved.
    if (controls.hidden !== !hunkRect) controls.hidden = !hunkRect;
    if (!hunkRect) return;
    // A hidden element has no box, so its width can only be read once it is shown.
    if (!controls._ccWidth) controls._ccWidth = controls.getBoundingClientRect().width;
    const width = controls._ccWidth;
    // Sit to the left of the hunk, but fall back to its right edge when the card is
    // too narrow for that — on a phone most hunks start near the left margin.
    let left = hunkRect.left - width - 4;
    if (left < cardRect.left + 4) left = Math.min(hunkRect.right + 4, cardRect.right - width - 4);
    const transform = `translate3d(${Math.max(4, left)}px, ${Math.max(cardRect.top, hunkRect.top)}px, 0)`;
    if (controls.style.transform !== transform) controls.style.transform = transform;
}
function positionPendingControls() {
    if (!controlsPositionFrame) controlsPositionFrame = requestAnimationFrame(performPendingControlsPosition);
}
function hunkControlsElement() {
    const existing = document.querySelector('.cc-floating-hunk-controls');
    if (existing) return existing;
    const controls = document.createElement('div');
    controls.className = 'cc-hunk-controls cc-floating-hunk-controls';
    controls.hidden = true;
    controls.innerHTML = '<button data-action="accept" title="Accept" type="button"><i class="fa-solid fa-check"></i></button><button data-action="reject" title="Reject" type="button"><i class="fa-solid fa-xmark"></i></button>';
    // These controls are attached to document.body so they can float over the
    // field without affecting its layout. Keep their events from reaching the
    // app-wide "click outside an open drawer" handler.
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        controls.addEventListener(type, event => event.stopPropagation());
    }
    controls.addEventListener('pointerenter', cancelHunkControlsHide);
    controls.addEventListener('pointerleave', scheduleHunkControlsHide);
    controls.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const field = activeHunk?.isConnected ? activeHunk.closest('.cc-pending-field') : null;
        if (field?.classList.contains('cc-lore-pending-field')) {
            resolveLorePending(field.dataset.loreEntry, field.dataset.loreProperty, Number(activeHunk.dataset.hunk), button.dataset.action);
        } else if (field) {
            resolvePending(field.dataset.field, Number(activeHunk.dataset.hunk), button.dataset.action, field.dataset.index === undefined ? null : Number(field.dataset.index));
        }
    }));
    document.body.append(controls);
    return controls;
}
function showHunkControls(hunk) {
    cancelHunkControlsHide();
    if (!hunk || hunk === activeHunk) return;
    activeHunk = hunk;
    hunkControlsElement();
    positionPendingControls();
}
function cancelHunkControlsHide() {
    clearTimeout(hideControlsTimer);
    hideControlsTimer = 0;
}
function hideHunkControls() {
    cancelHunkControlsHide();
    pinnedHunk = false;
    activeHunk = null;
    positionPendingControls();
}
function scheduleHunkControlsHide() {
    if (!activeHunk || pinnedHunk || hideControlsTimer) return;
    // The controls sit beside their hunk rather than inside it, so the pointer crosses
    // ordinary text on the way over. Wait a moment before dismissing them.
    hideControlsTimer = setTimeout(() => {
        hideControlsTimer = 0;
        if (pinnedHunk || activeHunk?.contains(document.activeElement)) return;
        activeHunk = null;
        positionPendingControls();
    }, HIDE_CONTROLS_DELAY);
}
function refreshHunkUnderPointer() {
    if (!cardPointer) return;
    // Resolving a hunk rebuilds the card, so re-target whatever now sits under the
    // pointer instead of making the user jiggle the mouse between edits.
    const hunk = document.elementFromPoint(cardPointer.x, cardPointer.y)?.closest?.('.cc-pending-hunk');
    if (hunk) showHunkControls(hunk);
}
function fieldControl(id, value, type = '') {
    if (isCollection(id)) return collectionControl(id);
    const pending = state.pending[id];
    if (pending) {
        return `<div class="cc-field-body cc-code-field has-pending" data-field="${id}">${lineNumberGutter(pending.after)}${pendingFieldControl(pending)}</div>`;
    }
    if (type === 'number') {
        return `<div class="cc-field-body" data-field="${id}"><input class="text_pole cc-field-number" data-field="${id}" type="number" min="0" inputmode="numeric" value="${escapeHtml(value)}"></div>`;
    }
    return `<div class="cc-field-body cc-code-field" data-field="${id}">${lineNumberGutter(value)}<textarea class="text_pole cc-field-input" data-field="${id}" rows="1" wrap="soft">${escapeHtml(value)}</textarea></div>`;
}
function loreInput(entryId, property, value, type = 'text') {
    const placeholder = property === 'keys' ? 'e.g. tavern, inn, The Rusty Tankard' : '';
    const ariaLabel = property === 'keys' ? ' aria-label="Entry keys"' : '';
    const common = `data-lore-entry="${escapeHtml(entryId)}" data-lore-property="${property}" title="${escapeHtml(LORE_FIELD_HELP[property] || '')}"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}${ariaLabel}`;
    if (type === 'checkbox') return `<input ${common} type="checkbox" ${value ? 'checked' : ''}>`;
    return `<input class="text_pole" ${common} type="${type}" value="${escapeHtml(Array.isArray(value) ? value.join(', ') : value ?? '')}">`;
}
function lorebookTokenSource() {
    return (state.lorebook?.entries || []).map(entry => String(entry.content || '')).filter(Boolean).join('\n');
}
async function updateLorebookTokenCount() {
    if (!state.lorebook) return;
    const source = lorebookTokenSource();
    const sourceHash = getStringHash(source);
    const count = source ? await getTokenCountAsync(source) : 0;
    if (!state.lorebook || getStringHash(lorebookTokenSource()) !== sourceHash) return;
    const counter = $('#cc-lore-token-count');
    if (!counter) return;
    counter.textContent = `${count.toLocaleString()} ${count === 1 ? 'token' : 'tokens'}`;
}
const updateLorebookTokenCountDebounced = debounce(() => void updateLorebookTokenCount(), 300);
function lorebookSectionHtml() {
    if (!state.lorebook) return `<section class="cc-field cc-lorebook" id="cc-field-lorebook">
        <div class="cc-field-label"><span title="Character Book entries add context to the prompt when their keys match recent chat text.">Character Book</span><div class="cc-lore-header-actions"><button class="menu_button menu_button_icon" data-lore-action="create" type="button" title="Embed a Character Book in this card and open its first entry."><i class="fa-solid fa-book-medical"></i><span>Create Book</span></button></div></div>
        <div class="cc-lore-empty">No character book</div>
    </section>`;
    const entries = state.lorebook.entries || [];
    return `<section class="cc-field cc-lorebook" id="cc-field-lorebook">
        <div class="cc-field-label"><span class="cc-lore-heading" title="Character Book entries add context to the prompt when their keys match recent chat text.">Character Book <small id="cc-lore-token-count" title="Combined token count for all entry content using the current tokenizer.">… tokens</small></span><div class="cc-lore-header-actions">
            <button class="menu_button menu_button_icon" data-lore-action="add" type="button" title="Add another matching rule to this Character Book."><i class="fa-solid fa-plus"></i><span>Add Entry</span></button>
            <button class="menu_button menu_button_icon cc-lore-delete-book" data-lore-action="delete-book" type="button" title="Remove this Character Book and all of its entries from the card." aria-label="Remove Character Book"><i class="fa-solid fa-trash-can"></i></button>
        </div></div>
        <div class="cc-lore-entries">${entries.length ? entries.map((entry, index) => loreEntryHtml(entry, index, state.loreEntryIds[index])).join('') : '<div class="cc-lore-empty">No entries</div>'}</div>
    </section>`;
}
function loreEntryHtml(entry, index, entryId) {
    const expanded = state.expandedLoreEntries.includes(entryId);
    const title = loreEntryLabel(entry, index);
    const isAiAdded = Boolean(state.lorebookProposal && !state.lorebookProposal.beforeIds?.includes(entryId));
    const namePending = lorePendingChange(entryId, 'name');
    const keysPending = lorePendingChange(entryId, 'keys');
    const constantPending = lorePendingChange(entryId, 'constant');
    const contentPending = lorePendingChange(entryId, 'content');
    const nameControl = namePending
        ? lorePendingControl(entryId, 'name', namePending, { className: 'cc-lore-inline-pending cc-lore-name' })
        : `<input class="text_pole cc-lore-name" data-lore-entry="${escapeHtml(entryId)}" data-lore-property="name" type="text" value="${escapeHtml(title)}" title="${escapeHtml(LORE_FIELD_HELP.name)}" aria-label="Entry name">`;
    const keysControl = keysPending
        ? lorePendingControl(entryId, 'keys', keysPending, { className: 'cc-lore-inline-pending' })
        : loreInput(entryId, 'keys', entry.keys);
    const constantControl = constantPending
        ? lorePendingControl(entryId, 'constant', constantPending, { editable: false, className: 'cc-lore-constant-pending', tag: 'span' })
        : loreInput(entryId, 'constant', entry.constant, 'checkbox');
    const contentControl = contentPending
        ? `${lineNumberGutter(contentPending.after)}${lorePendingControl(entryId, 'content', contentPending, { className: 'cc-field-input cc-lore-content' })}`
        : `${lineNumberGutter(entry.content || '')}<textarea class="text_pole cc-field-input cc-lore-content" data-lore-entry="${escapeHtml(entryId)}" data-lore-property="content" title="${escapeHtml(LORE_FIELD_HELP.content)}" rows="1" wrap="soft">${escapeHtml(entry.content || '')}</textarea>`;
    return `<article class="cc-lore-entry${isAiAdded ? ' cc-lore-entry-ai-added' : ''}" id="cc-lore-entry-${escapeHtml(entryId)}" data-entry-id="${escapeHtml(entryId)}">
        <div class="cc-lore-entry-header">
            <div class="cc-lore-header-fields">
                ${nameControl}
                <div class="cc-lore-keys" title="${escapeHtml(LORE_FIELD_HELP.keys)}"><span>Keys</span>${keysControl}</div>
            </div>
            <button class="cc-lore-toggle" data-lore-action="toggle" type="button" aria-expanded="${expanded}" title="${expanded ? 'Collapse entry' : 'Edit entry content'}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(title)}">
                <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}"></i>
            </button>
            <button class="cc-lore-delete" data-lore-action="delete" title="Delete entry" aria-label="Delete ${escapeHtml(title)}" type="button"><i class="fa-solid fa-trash-can"></i></button>
        </div>
        ${expanded ? `<div class="cc-lore-editor">
            <label class="cc-lore-check" title="${escapeHtml(LORE_FIELD_HELP.constant)}">${constantControl} Constant</label>
            <label class="cc-lore-content-label" title="${escapeHtml(LORE_FIELD_HELP.content)}">Content</label>
            <div class="cc-field-body cc-code-field${contentPending ? ' has-pending' : ''}" data-lore-target="${escapeHtml(entryId)}:content">${contentControl}</div>
        </div>` : ''}
    </article>`;
}
function bindLorebookControls(card) {
    card.querySelectorAll('[data-lore-action]').forEach(button => {
        if (button.dataset.loreActionBound === 'true') return;
        button.dataset.loreActionBound = 'true';
        button.addEventListener('click', () => void lorebookAction(button));
    });
    card.querySelectorAll('[data-lore-entry][data-lore-property]').forEach(input => {
        if (input.classList.contains('cc-lore-content')) {
            autoSize(input);
            scheduleLineNumberUpdate(input, { immediate: true });
        }
        if (input.dataset.loreInputBound === 'true') return;
        input.dataset.loreInputBound = 'true';
        input.addEventListener('focus', () => {
            input._loreEditSnapshot = deepCopy(cardSnapshot(state));
            input._loreEditBefore = deepCopy(loreEntry(input.dataset.loreEntry)?.[input.dataset.loreProperty]);
        });
        if (input.classList.contains('cc-lore-inline-pending')) input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        });
        input.addEventListener('input', () => {
            const entry = loreEntry(input.dataset.loreEntry); if (!entry) return;
            const value = input instanceof HTMLInputElement
                ? (input.type === 'checkbox' ? input.checked : input.value)
                : fieldEditorValue(input);
            setLoreProperty(entry, input.dataset.loreProperty, value);
            updateLorebookProposalAfter();
            writeLorebookToCard(); persist();
            if (input.classList.contains('cc-lore-content')) { autoSize(input); scheduleLineNumberUpdate(input); updateLorebookTokenCountDebounced(); }
        });
        input.addEventListener('blur', () => {
            const after = loreEntry(input.dataset.loreEntry)?.[input.dataset.loreProperty];
            if (input._loreEditSnapshot && JSON.stringify(input._loreEditBefore) !== JSON.stringify(after)) {
                pushHistory(undo, input._loreEditSnapshot); redo = [];
                checkpoint(`${loreEntryLabel(loreEntry(input.dataset.loreEntry), loreEntryIndex(input.dataset.loreEntry))} ${lorePropertyLabel(input.dataset.loreProperty)} manual edit`, input._loreEditSnapshot, changeContent(loreValueText(input._loreEditBefore), loreValueText(after)));
            }
            if (input.classList.contains('cc-lore-pending-field') || input.classList.contains('cc-lore-content')) { renderCard(); renderChat(); }
        });
        input.addEventListener('change', () => { if (!input.classList.contains('cc-lore-content')) renderCard(); });
    });
    void updateLorebookTokenCount();
}
function resolveLorebookProposal(action, { renderAfter = true } = {}) {
    const proposal = state.lorebookProposal;
    if (!proposal) return;
    if (action === 'reject') {
        state.lorebook = deepCopy(proposal.before);
        state.loreEntryIds = deepCopy(proposal.beforeIds);
        state.expandedLoreEntries = state.expandedLoreEntries.filter(id => state.loreEntryIds.includes(id));
        addCardNotice('Character Book');
    }
    state.lorebookProposal = null;
    writeLorebookToCard();
    persistWorkspace();
    if (renderAfter) { renderCard(); renderChat(); renderPendingActions(); }
}
function resolveLorePending(entryId, property, hunkIndex, action) {
    const proposal = state.lorebookProposal;
    const pending = lorePendingChange(entryId, property);
    if (!proposal || !pending) return;
    const hunk = pendingDiffParts(pending).find(part => part.type === 'hunk' && part.index === hunkIndex);
    if (!hunk) return;
    const beforeIndex = proposal.beforeIds.indexOf(entryId);
    const afterIndex = state.loreEntryIds.indexOf(entryId);
    if (beforeIndex < 0 || afterIndex < 0) return;
    const before = record();
    const removed = property === 'constant' ? pending.before : hunk.removed;
    const added = property === 'constant' ? pending.after : hunk.added;
    checkpoint(`${loreEntryLabel(state.lorebook.entries[afterIndex], afterIndex)} ${lorePropertyLabel(property)} AI proposal`, before, changeContent(removed, added));
    const applyText = (entry, text) => {
        if (property === 'constant') entry[property] = /^(?:yes|true)$/i.test(text.trim());
        else setLoreProperty(entry, property, text);
    };
    // A checkbox has one semantic value even if the text differ happens to split
    // "Yes" and "No" into multiple character hunks. Resolve it atomically so a
    // rejected toggle cannot immediately reappear as another pending fragment.
    if (property === 'constant') {
        if (action === 'accept') proposal.before.entries[beforeIndex].constant = state.lorebook.entries[afterIndex].constant;
        else {
            state.lorebook.entries[afterIndex].constant = Boolean(proposal.before.entries[beforeIndex].constant);
            addCardNotice('Character Book');
        }
    } else if (action === 'accept') {
        const next = `${pending.before.slice(0, hunk.beforeStart)}${hunk.added}${pending.before.slice(hunk.beforeEnd)}`;
        applyText(proposal.before.entries[beforeIndex], next);
    } else {
        const next = `${pending.after.slice(0, hunk.afterStart)}${hunk.removed}${pending.after.slice(hunk.afterEnd)}`;
        applyText(state.lorebook.entries[afterIndex], next);
        addCardNotice('Character Book');
    }
    updateLorebookProposalAfter();
    writeLorebookToCard();
    renderCard();
    renderChat();
    renderPendingActions();
    persistWorkspace();
    return true;
}
async function lorebookAction(button) {
    const action = button.dataset.loreAction;
    if (action === 'create') {
        record();
        const entryId = uuidv4();
        state.lorebook = createLorebook();
        state.lorebook.entries.push(normalizeLoreEntry({ name: 'Entry 1' }));
        state.loreEntryIds = [entryId];
        state.expandedLoreEntries = [entryId];
        updateLorebookProposalAfter();
        writeLorebookToCard(); renderCard(); persist(); return;
    }
    if (action === 'add') {
        record(); const entryId = uuidv4(); state.lorebook.entries.push(normalizeLoreEntry({ name: `Entry ${state.lorebook.entries.length + 1}` })); state.loreEntryIds.push(entryId); state.expandedLoreEntries.push(entryId); updateLorebookProposalAfter(); writeLorebookToCard(); renderCard(); persist(); return;
    }
    if (action === 'delete-book') {
        const entryCount = state.lorebook?.entries?.length || 0;
        const entriesText = entryCount ? ` and ${entryCount === 1 ? 'its entry' : `all ${entryCount} entries`}` : '';
        const confirmed = await Popup.show.confirm('Remove Character Book?', `Remove the embedded Character Book${entriesText} from this card? You can undo this with Ctrl+Z.`, { okButton: 'Remove', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        record();
        state.lorebook = null;
        state.loreEntryIds = [];
        state.expandedLoreEntries = [];
        state.lorebookProposal = null;
        writeLorebookToCard(); renderCard(); renderPendingActions(); persist(); return;
    }
    const row = button.closest('.cc-lore-entry'); const entryId = row?.dataset.entryId; const index = loreEntryIndex(entryId); if (index < 0) return;
    if (action === 'toggle') {
        if (state.expandedLoreEntries.includes(entryId)) state.expandedLoreEntries = state.expandedLoreEntries.filter(id => id !== entryId); else state.expandedLoreEntries.push(entryId);
        renderCard(); persist(); return;
    }
    if (action === 'delete') {
        const confirmed = await Popup.show.confirm('Delete lorebook entry?', `Delete “${loreEntryLabel(state.lorebook.entries[index], index)}”? You can undo this with Ctrl+Z.`, { okButton: 'Delete', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    record();
    if (action === 'delete') {
        state.lorebook.entries.splice(index, 1); state.loreEntryIds.splice(index, 1); state.expandedLoreEntries = state.expandedLoreEntries.filter(id => id !== entryId);
    }
    updateLorebookProposalAfter();
    writeLorebookToCard(); renderCard(); persist();
}
function cardFieldHtml(id) {
    const { label, type } = fieldById.get(id);
    return `<div class="cc-field" id="cc-field-${id}"><div class="cc-field-label"><span>${label}</span>${isCollection(id) ? `<button class="cc-add-collection menu_button menu_button_icon" data-add-collection="${id}" type="button" title="Add ${id === 'examples' ? 'example' : 'greeting'}"><i class="fa-solid fa-plus"></i><span>Add</span></button>` : ''}</div>${fieldControl(id, effectiveValue(id), type)}</div>`;
}
function cardSectionTabsHtml(activeSection) {
    return `<div class="cc-card-section-tabs" role="tablist" aria-label="Character card sections">${CARD_SECTIONS.map(section => `<button id="cc-card-tab-${section.id}" role="tab" type="button" data-card-section="${section.id}" aria-selected="${section.id === activeSection}" aria-controls="cc-card-panel-${section.id}" tabindex="${section.id === activeSection ? '0' : '-1'}" title="${section.label} card fields">${section.label}</button>`).join('')}</div>`;
}
function cardSectionPanelHtml(activeSection) {
    return CARD_SECTIONS.map(section => {
        const active = section.id === activeSection;
        const content = !active
            ? ''
            : section.id === 'lorebook'
                ? lorebookSectionHtml()
                : section.fields.map(cardFieldHtml).join('');
        return `<div id="cc-card-panel-${section.id}" class="cc-card-section" data-card-section-panel="${section.id}" role="tabpanel" aria-labelledby="cc-card-tab-${section.id}"${active ? '' : ' hidden'}>${content}</div>`;
    }).join('');
}
function rememberCardSectionScroll() {
    const card = $('#cc-editor-card');
    const renderedSection = card?.querySelector('[data-card-section-panel]:not([hidden])')?.dataset.cardSectionPanel;
    if (!card || !state || !renderedSection) return;
    state.cardSectionScrollTops[renderedSection] = card.scrollTop;
}
function switchCardSection(section, { focusTab = false } = {}) {
    if (!state) return;
    const nextSection = normalizeCardSection(section);
    rememberCardSectionScroll();
    if (state.cardSection !== nextSection) {
        state.cardSection = nextSection;
        renderCard();
        persist();
    }
    if (focusTab) $(`#cc-card-tab-${nextSection}`)?.focus();
}
function bindCardSectionTabs(card) {
    const tabs = [...card.querySelectorAll('[role="tab"][data-card-section]')];
    for (const tab of tabs) {
        if (tab.dataset.cardTabBound === 'true') continue;
        tab.dataset.cardTabBound = 'true';
        tab.addEventListener('click', () => switchCardSection(tab.dataset.cardSection, { focusTab: true }));
        tab.addEventListener('keydown', event => {
            const index = tabs.indexOf(tab);
            let nextIndex = null;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            switchCardSection(tabs[nextIndex].dataset.cardSection, { focusTab: true });
        });
    }
}
function preserveRuntimeBindingAttributes(fromElement, toElement) {
    for (const attribute of fromElement.attributes || []) {
        if (attribute.name.endsWith('-bound')) toElement.setAttribute(attribute.name, attribute.value);
    }
    return true;
}
function cardNodeKey(node) {
    if (!(node instanceof HTMLElement)) return undefined;
    if (node.id) return node.id;
    if (node.dataset.loreEntry && node.dataset.loreProperty) return `lore-input:${node.dataset.loreEntry}:${node.dataset.loreProperty}`;
    if (node.dataset.entryId) return `lore-entry:${node.dataset.entryId}`;
    if (node.dataset.field && node.matches('textarea, input, [contenteditable="true"]')) return `field:${node.dataset.field}:${node.dataset.index ?? 'main'}:${node.tagName}`;
    return undefined;
}
function renderCard() {
    const card = $('#cc-editor-card');
    rememberCardSectionScroll();
    const activeSection = normalizeCardSection(state.cardSection);
    state.cardSection = activeSection;
    const scrollTop = state.cardSectionScrollTops[activeSection] || 0;
    const fieldScrollTops = new Map();
    card.querySelectorAll('.cc-code-field').forEach(field => {
        const input = field.querySelector('[data-field]');
        if (!input) return;
        const key = `${input.dataset.field}:${input.dataset.index ?? 'main'}`;
        fieldScrollTops.set(key, field.scrollTop);
    });
    const restoreScrollPositions = () => {
        card.scrollTop = scrollTop;
        card.querySelectorAll('.cc-code-field').forEach(field => {
            const input = field.querySelector('[data-field]');
            if (!input) return;
            const key = `${input.dataset.field}:${input.dataset.index ?? 'main'}`;
            if (fieldScrollTops.has(key)) field.scrollTop = fieldScrollTops.get(key);
        });
    };
    removeFloatingHunkControls();
    fieldLineNumberObserver?.disconnect();
    fieldLineNumberObserver ||= new ResizeObserver(entries => {
        for (const entry of entries) {
            scheduleLineNumberUpdate(entry.target);
            // Width changes alter textarea scrollHeight even when the value is
            // unchanged. The guarded cache makes the height-only callback a no-op.
            if (entry.target instanceof HTMLTextAreaElement) autoSize(entry.target);
        }
    });
    const target = card.cloneNode(false);
    target.innerHTML = `${cardSectionTabsHtml(activeSection)}${cardSectionPanelHtml(activeSection)}`;
    morphdom(card, target, { childrenOnly: true, getNodeKey: cardNodeKey, onBeforeElUpdated: preserveRuntimeBindingAttributes });
    bindCardSectionTabs(card);
    card.querySelectorAll('.cc-field-input[data-field], .cc-field-number[data-field]').forEach(input => {
        const heightKey = `${input.dataset.field}:${input.dataset.index ?? 'main'}`;
        input.dataset.heightKey = heightKey;
        if (input instanceof HTMLTextAreaElement) {
            autoSize(input);
        }
        if (input.classList.contains('cc-field-input')) {
            // Incremental DOM updates can replace the gutter while preserving the
            // textarea. Refresh every visible gutter even when autoSize correctly
            // skips an unchanged textarea from its measurement cache.
            scheduleLineNumberUpdate(input, { immediate: true });
            // A pending field lays out both its generated removed text and its
            // editable proposed text, while its gutter intentionally measures only
            // the proposed value. Observing that intrinsically-sized contenteditable
            // creates a resize -> gutter measurement -> resize feedback loop in
            // Firefox on large diffs. Pending gutters are refreshed by input and by
            // the render after blur; stable textareas can keep live resize tracking.
            if (!input.classList.contains('cc-pending-field')) {
                fieldLineNumberObserver.observe(input);
            }
        }
        if (input.dataset.cardFieldBound === 'true') return;
        input.dataset.cardFieldBound = 'true';
        input.addEventListener('focus', () => {
            const id = input.dataset.field;
            const index = input.dataset.index ?? null;
            focusedEdit = {
                id,
                index,
                beforeValue: index === null ? asText(effectiveValue(id)) : String(effectiveValue(id)?.[Number(index)] ?? ''),
                snapshot: null,
            };
        });
        input.addEventListener('input', () => onFieldInput(input));
        input.addEventListener('blur', () => {
            const hadPending = Boolean(state.pending[input.dataset.field]);
            if (focusedEdit) {
                const edit = focusedEdit;
                focusedEdit = null;
                const currentValue = edit.index === null
                    ? asText(effectiveValue(edit.id))
                    : String(effectiveValue(edit.id)?.[Number(edit.index)] ?? '');
                if (edit.snapshot && edit.beforeValue !== currentValue) {
                    const before = edit.snapshot;
                    pushHistory(undo, before); redo = [];
                    checkpoint(`${fieldLabel(edit.id, edit.index)} manual edit`, before, changeContent(edit.beforeValue, currentValue));
                    if (appendPendingCardChangeNotice(activeConversation())) renderChat();
                }
            }
            persist();
            if (hadPending) renderCard();
        });
    });
    card.querySelectorAll('[data-collection-action]').forEach(button => {
        if (button.dataset.collectionActionBound === 'true') return;
        button.dataset.collectionActionBound = 'true';
        button.addEventListener('click', () => void collectionAction(button));
    });
    card.querySelectorAll('[data-add-collection]').forEach(button => {
        if (button.dataset.addCollectionBound === 'true') return;
        button.dataset.addCollectionBound = 'true';
        button.addEventListener('click', () => { const id = button.dataset.addCollection; record(); checkpoint(fieldLabel(id), snapshot(), asText(state.values[id])); state.values[id].push(''); setCardValue(id, state.values[id]); saveCharacterDebounced(); appendPendingCardChangeNotice(activeConversation()); renderCard(); renderChat(); persist(); });
    });
    bindLorebookControls(card);
    restoreScrollPositions();
    requestAnimationFrame(() => {
        if (card.isConnected) restoreScrollPositions();
    });
    refreshHunkUnderPointer();
}
function onFieldInput(input) {
    const id = input.dataset.field;
    // Manual card undo does not restore conversation or layout state. Copying only
    // the card keeps this path independent of an arbitrarily long editor history.
    if (focusedEdit && !focusedEdit.snapshot) focusedEdit.snapshot = deepCopy(cardSnapshot(state));
    let inputValue = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
        ? input.value
        : input.innerText.replaceAll('\r\n', '\n');
    inputValue = normalizeFieldStateValue(id, inputValue);
    if (isCollection(id)) {
        const values = [...effectiveValue(id)]; values[Number(input.dataset.index)] = inputValue;
        state.values[id] = values; setCardValue(id, values); saveCharacterDebounced();
        if (state.pending[id]) { state.pending[id].after = deepCopy(values); syncToolCall(state.pending[id]); }
    } else if (state.pending[id]) {
        state.values[id] = inputValue; setCardValue(id, inputValue); saveCharacterDebounced();
        state.pending[id].after = inputValue; syncToolCall(state.pending[id]);
    }
    else { state.values[id] = inputValue; setCardValue(id, inputValue); saveCharacterDebounced(); }
    scheduleLineNumberUpdate(input); autoSize(input); persist();
}
async function collectionAction(button) {
    const row = button.closest('.cc-collection-row');
    const id = row.querySelector('[data-field]').dataset.field;
    const index = Number(row.querySelector('[data-index]').dataset.index);
    if (button.dataset.collectionAction === 'delete') {
        const confirmed = await Popup.show.confirm(
            `Delete ${fieldLabel(id, index)}?`,
            'This removes it from the character card. You can undo this with Ctrl+Z.',
            { okButton: 'Delete', cancelButton: 'Cancel' },
        );
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    record();
    checkpoint(fieldLabel(id, index), snapshot(), changeContent(String(state.values[id][index] ?? ''), ''));
    const values = [...state.values[id]];
    if (button.dataset.collectionAction === 'delete') values.splice(index, 1);
    if (id === 'greetings' && values.length === 0) values.push('');
    state.values[id] = values;
    setCardValue(id, values);
    saveCharacterDebounced();
    const noticed = appendPendingCardChangeNotice(activeConversation());
    renderCard();
    if (noticed) renderChat();
    persist();
}
function resolvePending(id, hunkIndex, action, index = null) {
    const pending = state.pending[id]; if (!pending) return;
    const target = index === null ? pending : { field: id, before: collectionItemValue(pending.before, index), after: collectionItemValue(pending.after, index) };
    const hunk = pendingDiffParts(target).find(part => part.type === 'hunk' && part.index === hunkIndex);
    if (!hunk) return;
    // The displayed hunk is calculated from the committed base and the current live
    // value, so its ranges are already the authoritative inverse. A hunk can contain
    // pieces from several tool records after semantic cleanup or overlapping edits;
    // requiring it to match exactly one historical record makes a valid revert fail.
    const before = record();
    checkpoint(`${fieldLabel(id, index)} AI proposal`, before, changeContent(hunk.removed, hunk.added));
    if (index === null) {
        if (action === 'accept') {
            const before = asText(pending.before);
            pending.before = valueFromText(id, `${before.slice(0, hunk.beforeStart)}${hunk.added}${before.slice(hunk.beforeEnd)}`);
        } else {
            const after = asText(pending.after);
            pending.after = valueFromText(id, `${after.slice(0, hunk.afterStart)}${hunk.removed}${after.slice(hunk.afterEnd)}`);
            state.values[id] = deepCopy(pending.after);
            setCardValue(id, pending.after);
            saveCharacterDebounced();
        }
    } else {
        if (action === 'accept') {
            const before = collectionItemValue(pending.before, index);
            pending.before = [...pending.before];
            pending.before[index] = `${before.slice(0, hunk.beforeStart)}${hunk.added}${before.slice(hunk.beforeEnd)}`;
        } else {
            const after = collectionItemValue(pending.after, index);
            pending.after = [...pending.after];
            pending.after[index] = `${after.slice(0, hunk.afterStart)}${hunk.removed}${after.slice(hunk.afterEnd)}`;
            state.values[id] = [...pending.after];
            setCardValue(id, state.values[id]);
            saveCharacterDebounced();
        }
    }
    if (!pendingDiffParts(pending).some(part => part.type === 'hunk')) delete state.pending[id];
    if (action === 'reject') addCardNotice(fieldLabel(id, index), contextResult(fieldLabel(id, index), index === null ? asText(pending.after) : collectionItemValue(pending.after, index)));
    // Changes are applied when proposed. Accepting only clears the reversible marker;
    // rejecting applies the targeted inverse hunk to the live card.
    renderCard();
    renderChat();
    renderPendingActions();
    persist();
    return true;
}
function resolveAllPending(action) {
    const pendingEntries = Object.entries(state.pending);
    const hasLoreProposal = Boolean(state.lorebookProposal);
    if (!pendingEntries.length && !hasLoreProposal) return;
    const before = record();
    // A global decision is a field-level operation. Building and resolving every
    // character hunk separately makes revert-all quadratic in practice because each
    // hunk re-diffs, re-renders, checkpoints, and persists the entire editor.
    const content = pendingEntries
        .map(([id, pending]) => `${fieldLabel(id)}\n${changeContent(asText(pending.before), asText(pending.after))}`)
        .join('\n\n');
    checkpoint('All AI proposals', before, content);
    if (action === 'reject') {
        const conversation = activeConversation();
        const labels = [];
        for (const [id, pending] of pendingEntries) {
            const restored = deepCopy(pending.before);
            state.values[id] = restored;
            setCardValue(id, restored);
            const label = fieldLabel(id);
            labels.push(label);
            if (conversation) {
                conversation.messages.push({
                    id: uuidv4(),
                    role: 'system',
                    text: `Card change rejected: ${label}.\n${contextResult(label, asText(restored))}`,
                });
            }
        }
        state.pending = {};
        if (hasLoreProposal) resolveLorebookProposal('reject', { renderAfter: false });
        saveCharacterDebounced();
        if (hasLoreProposal) labels.push('Character Book');
        toastr.info(`Card changes reverted: ${labels.join(', ')}`, 'Character card editor');
    }
    if (action === 'accept') { state.pending = {}; state.lorebookProposal = null; }
    renderCard();
    renderChat();
    renderPendingActions();
    persistWorkspace();
}
function addCardNotice(label, context = '') {
    toastr.info(`Card change rejected: ${label}`, 'Character card editor');
    const conversation = activeConversation();
    if (!conversation) return;
    conversation.messages.push({ id: uuidv4(), role: 'system', text: `Card change rejected: ${label}.${context ? `\n${context}` : ''}` });
    renderChat();
}
function toToolXml(pending) {
    const label = fieldById.get(pending.field)?.label || pending.field;
    const proposalText = (proposal, value) => proposal?.index === null || proposal?.index === undefined ? asText(value) : collectionItemValue(value, proposal.index);
    const proposals = pending.operations?.length ? pending.operations : [{ rewrite: true }];
    return proposals.map(proposal => {
        const proposalLabel = proposal.label || label;
        if (proposal.rewrite) return `<rewrite_card_field><field>${xmlText(proposalLabel)}</field><content>${xmlText(proposalText(proposal, pending.after))}</content></rewrite_card_field>`;
        if (proposal.operation === 'delete-span') {
            return `<delete_card_span><field>${xmlText(proposalLabel)}</field><from>${xmlText(proposal.from)}</from><until>${xmlText(proposal.until)}</until></delete_card_span>`;
        }
        if (proposal.operation === 'insert') {
            const anchor = proposal.anchor ? `<anchor>${xmlText(proposal.anchor)}</anchor>` : '';
            return `<insert_card_text><field>${xmlText(proposalLabel)}</field><content>${xmlText(proposal.content)}</content><position>${xmlText(proposal.position)}</position>${anchor}</insert_card_text>`;
        }
        return `<replace_card_text><field>${xmlText(proposalLabel)}</field><find>${xmlText(proposal.find)}</find><replace>${xmlText(proposal.replace)}</replace></replace_card_text>`;
    }).join('\n');
}
function syncToolCall(pending) {
    const message = state.conversations.flatMap(conversation => conversation.messages).find(item => item.id === pending.messageId);
    if (!message) return;
    const index = message.diffs?.findIndex(diff => diff.field === pending.field) ?? -1;
    if (index >= 0) message.diffs[index] = pending;
    message.toolXml = (message.diffs || [pending]).map(toToolXml).join('\n');
    message.raw = `${message.text || ''}${message.text && message.toolXml ? '\n' : ''}${message.toolXml}`;
}
function applyLiveEdit(edit) {
    const value = deepCopy(edit.after);
    state.values[edit.field] = value;
    setCardValue(edit.field, value);
    saveCharacterDebounced();
}
function addPendingEdit(edit) {
    const existing = state.pending[edit.field];
    if (!existing) {
        state.pending[edit.field] = { ...edit, applied: true };
        return;
    }
    // The new edit was resolved against the existing combined proposal. Keep the
    // committed base so separated earlier hunks remain independently actionable;
    // diffing base to the new result also coalesces changes that now touch.
    // Do not mutate `existing`: the assistant message that introduced it keeps
    // the same object in its `diffs` array and must remain immutable in history.
    state.pending[edit.field] = {
        ...deepCopy(existing),
        after: deepCopy(edit.after),
        messageId: edit.messageId,
        operations: deepCopy(edit.operations),
        applied: true,
    };
}
function rawMessageText(message) {
    if (typeof message.raw === 'string') return message.raw;
    return `${message.text || ''}${message.text && message.toolXml ? '\n' : ''}${message.toolXml || ''}`;
}
function characterCount(value) {
    return Array.from(String(value ?? '')).length;
}
function lorebookChangeCounts(diff) {
    const beforeIds = diff?.beforeIds || [];
    const afterIds = diff?.afterIds || [];
    const beforeEntries = diff?.before?.entries || [];
    const afterEntries = diff?.after?.entries || [];
    const added = afterIds.filter(id => !beforeIds.includes(id)).length;
    const removed = beforeIds.filter(id => !afterIds.includes(id)).length;
    let updated = 0;
    for (const id of afterIds) {
        const beforeIndex = beforeIds.indexOf(id);
        if (beforeIndex < 0) continue;
        const afterIndex = afterIds.indexOf(id);
        if (JSON.stringify(beforeEntries[beforeIndex]) !== JSON.stringify(afterEntries[afterIndex])) updated++;
    }
    return { added, removed, updated };
}
function lorebookChangeSummary(diff) {
    const { added, removed, updated } = lorebookChangeCounts(diff);
    const parts = [];
    if (added) parts.push(`added ${added} ${added === 1 ? 'entry' : 'entries'}`);
    if (updated) parts.push(`updated ${updated} ${updated === 1 ? 'entry' : 'entries'}`);
    if (removed) parts.push(`removed ${removed} ${removed === 1 ? 'entry' : 'entries'}`);
    if (!parts.length) return 'Character Book unchanged';
    const summary = parts.join(', ');
    return `${summary[0].toUpperCase()}${summary.slice(1)}.`;
}
function editResultSummary(diffs) {
    if (Array.isArray(diffs) && editSummaryCache.has(diffs)) return editSummaryCache.get(diffs);
    let added = 0;
    let removed = 0;
    const loreSummaries = [];
    for (const diff of diffs || []) {
        if (diff.lorebook) {
            loreSummaries.push(lorebookChangeSummary(diff));
            continue;
        }
        const dmp = createUiDiffer();
        for (const [operation, text] of dmp.diff_main(asText(diff.before), asText(diff.after))) {
            if (operation > 0) added += characterCount(text);
            if (operation < 0) removed += characterCount(text);
        }
    }
    const parts = [];
    if (added) parts.push(`Added ${added} ${added === 1 ? 'character' : 'characters'}`);
    if (removed) parts.push(`removed ${removed} ${removed === 1 ? 'character' : 'characters'}`);
    if (!parts.length) {
        const summary = loreSummaries.join(' ');
        if (Array.isArray(diffs)) editSummaryCache.set(diffs, summary);
        return summary;
    }
    const summary = parts.join(', ');
    const result = [`${summary[0].toUpperCase()}${summary.slice(1)}.`, ...loreSummaries].join(' ');
    if (Array.isArray(diffs)) editSummaryCache.set(diffs, result);
    return result;
}
function contextReadoutText(contextXml) {
    const match = String(contextXml || '').match(/<context\b[^>]*>([\s\S]*?)<\/context>/i);
    if (!match) return '';
    const document = new DOMParser().parseFromString(`<textarea>${match[1]}</textarea>`, 'text/html');
    return (document.querySelector('textarea')?.value ?? match[1]).trim();
}
function lorebookReadoutText(resultXml) {
    const match = String(resultXml || '').match(/<character_book\b[^>]*>([\s\S]*?)<\/character_book>/i);
    if (!match) return '';
    const document = new DOMParser().parseFromString(`<textarea>${match[1]}</textarea>`, 'text/html');
    const value = (document.querySelector('textarea')?.value ?? match[1]).trim();
    try {
        const entries = JSON.parse(value)?.entries || [];
        const names = entries.map((entry, index) => String(entry?.name || `Entry ${index + 1}`));
        const count = entries.length;
        return `${count} ${count === 1 ? 'entry' : 'entries'}${names.length ? `: ${names.join(', ')}` : ''}`;
    } catch {
        return value;
    }
}
function unchangedReadoutText(result) {
    const text = String(result || '').trim();
    return text.endsWith(UNCHANGED_READ_RESULT_SUFFIX) ? text : '';
}
function readResultReadouts(message) {
    if (message.readResults?.length) return message.readResults.map(result => contextReadoutText(result) || lorebookReadoutText(result) || unchangedReadoutText(result)).filter(Boolean);
    if (!message.toolXml) return [];
    const calls = parseCharacterDesignerToolCalls(message.toolXml || '').calls.filter(call => !call.error);
    const labels = new Set(parseReadRequests(calls).reads.map(read => read.label));
    const contextReadouts = [...String(message.toolResult || '').matchAll(/<context\b[^>]*>[\s\S]*?<\/context>/gi)]
        .map(match => contextReadoutText(match[0]))
        .filter(text => [...labels].some(label => text === `${label}:` || text.startsWith(`${label}:\n`)));
    const lorebookReadouts = [...String(message.toolResult || '').matchAll(/<character_book\b[^>]*>[\s\S]*?<\/character_book>/gi)]
        .map(match => lorebookReadoutText(match[0]))
        .filter(Boolean);
    const unchangedReadouts = String(message.toolResult || '').split('\n').map(unchangedReadoutText).filter(Boolean);
    return [...contextReadouts, ...lorebookReadouts, ...unchangedReadouts];
}
function contextToolResultText(result) {
    const target = String(result?.target || 'Tool');
    const output = String(result?.output || '').trim();
    const error = String(result?.error || '').trim();
    if (result?.status === 'error') return `${target} failed: ${error || 'The tool call could not be completed.'}`;
    if (result?.tool === 'random_keywords') return `Selected random keywords: ${output || '(none)'}`;
    return output || `${target} completed.`;
}
function contextToolResultReadouts(message) {
    let results = Array.isArray(message.contextToolResults) ? message.contextToolResults : [];
    // Workspaces saved before context results became first-class UI data still
    // contain the canonical XML sent back to the model. Recover those records so
    // an old avatar/keyword result also becomes visible after upgrading.
    if (!results.length && message.toolResult) {
        const document = new DOMParser().parseFromString(`<results>${String(message.toolResult)}</results>`, 'application/xml');
        if (!document.querySelector('parsererror')) {
            results = [...document.querySelectorAll('result')].map(node => ({
                tool: node.querySelector('tool')?.textContent || '',
                status: node.querySelector('status')?.textContent || '',
                target: node.querySelector('target')?.textContent || '',
                output: node.querySelector('output')?.textContent || '',
                error: node.querySelector('error')?.textContent || '',
            })).filter(result => ['random_keywords', 'set_avatar_from_attachment'].includes(result.tool));
        }
    }
    return results
        .filter(result => result && ['success', 'error'].includes(result.status))
        .map(result => ({ status: result.status, text: contextToolResultText(result) }));
}
function isUnchangedReadFailure(error) {
    const detail = error?.detail || error?.message || '';
    return error?.code === 'unchanged-card-section' || /byte-identical to the original card, so this read was refused\./.test(detail);
}
function groupToolFailures(errors) {
    const unchangedReads = errors.filter(isUnchangedReadFailure);
    if (unchangedReads.length < 2) return errors;
    const labels = [...new Set(unchangedReads.map(error => error?.proposal?.label).filter(Boolean))];
    const labelList = joinedLabels(labels);
    const sections = labels.length === 1 ? 'that section' : 'those sections';
    const grouped = {
        ...unchangedReads[0],
        code: 'unchanged-card-section',
        detail: `The current ${labelList} ${labels.length === 1 ? 'is' : 'are'} byte-identical to the original card, so these reads were refused. Read them only after ${sections} change or choose different sections.`,
        message: `${labelList} ${labels.length === 1 ? 'is' : 'are'} unchanged from the original card.`,
        proposal: { label: labelList },
        rawTool: unchangedReads.map(error => error?.rawTool).filter(Boolean).join('\n'),
        retryable: true,
    };
    const firstIndex = errors.indexOf(unchangedReads[0]);
    const result = errors.filter(error => !unchangedReads.includes(error));
    result.splice(firstIndex, 0, grouped);
    return result;
}
function toolResultBubbleHtml(message) {
    const errors = groupToolFailures([...(message.errors || []), ...(message.error ? [message.error] : [])]);
    const summary = editResultSummary(message.diffs);
    const readouts = readResultReadouts(message);
    const contextReadouts = contextToolResultReadouts(message);
    if (!summary && !readouts.length && !contextReadouts.length && !errors.length && !message.toolResultOverride) return '';
    if (messageEdit.toolResultId === message.id) {
        return `<article class="cc-message cc-message-editing cc-tool-result-message" data-tool-result-for="${escapeHtml(message.id)}"><div class="cc-message-edit-actions"><button class="cc-tool-result-edit-save menu_button" type="button" title="Confirm"><i class="fa-solid fa-check"></i></button><button class="cc-tool-result-edit-cancel menu_button" type="button" title="Cancel"><i class="fa-solid fa-xmark"></i></button></div><label class="cc-message-edit-label">Tool result<textarea class="text_pole cc-message-edit-input" rows="1" spellcheck="false">${escapeHtml(messageEdit.toolResultDraft)}</textarea></label></article>`;
    }
    if (message.toolResultOverride) {
        return `<article class="cc-message cc-message-has-edit cc-tool-result-message" data-tool-result-for="${escapeHtml(message.id)}"><button class="cc-tool-result-edit cc-message-edit menu_button" type="button" title="Edit"><i class="fa-solid fa-pencil"></i></button><div class="cc-message-text">${formattedMessageText(message.toolResultOverride, 'system')}</div></article>`;
    }
    const summaryHtml = summary ? `<div class="cc-tool-result-summary">${escapeHtml(summary)}</div>` : '';
    const readoutsHtml = readouts.map(readout => `<div class="cc-tool-result-content">${escapeHtml(readout)}</div>`).join('');
    const contextHtml = contextReadouts.map(result => result.status === 'error'
        ? `<div class="cc-tool-error-text">${escapeHtml(result.text)}</div>`
        : `<div class="cc-tool-result-content">${escapeHtml(result.text)}</div>`).join('');
    const errorsHtml = errors.map(failedEditHtml).join('');
    return `<article class="cc-message cc-message-has-edit cc-tool-result-message" data-tool-result-for="${escapeHtml(message.id)}"><button class="cc-tool-result-edit cc-message-edit menu_button" type="button" title="Edit"><i class="fa-solid fa-pencil"></i></button><div class="cc-tool-result-readout">${summaryHtml}${readoutsHtml}${contextHtml}${errorsHtml}</div></article>`;
}
function toolResultPlainText(message) {
    if (message.toolResultOverride !== undefined) return String(message.toolResultOverride);
    const errors = groupToolFailures([...(message.errors || []), ...(message.error ? [message.error] : [])]);
    return [
        editResultSummary(message.diffs),
        ...readResultReadouts(message),
        ...contextToolResultReadouts(message).map(result => result.text),
        ...errors.map(error => error?.detail || error?.message || 'The tool call could not be validated.'),
    ].filter(Boolean).join('\n\n');
}
function formattedMessageText(text, role, reasoning = false) {
    return messageFormatting(String(text || ''), role === 'user' ? '' : (currentCharacter()?.name || 'Assistant'), false, role === 'user', -1, {}, reasoning);
}
function resetMessageEdit() {
    Object.assign(messageEdit, { id: null, draft: '', reasoning: '', error: '' });
}
function resetToolResultEdit() {
    Object.assign(messageEdit, { toolResultId: null, toolResultDraft: '' });
}
function beginMessageEdit(messageId) {
    const message = activeConversation()?.messages.find(item => item.id === messageId);
    if (!message || message.streaming) return;
    resetToolResultEdit();
    Object.assign(messageEdit, {
        id: messageId,
        draft: message.role === 'assistant' ? rawMessageText(message) : message.text || '',
        reasoning: message.role === 'assistant' ? message.reasoning || '' : '',
        error: '',
    });
    renderChat();
    requestAnimationFrame(() => {
        const editor = document.querySelector(`.cc-message[data-message-id="${CSS.escape(messageId)}"]`);
        editor?.querySelectorAll('.cc-message-edit-input').forEach(textarea => autoSize(textarea));
        const textarea = editor?.querySelector('[data-edit-part="response"]');
        textarea?.focus();
        if (textarea instanceof HTMLTextAreaElement) {
            textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
    });
}
function cancelMessageEdit() {
    resetMessageEdit();
    renderChat();
}
function beginToolResultEdit(messageId) {
    const message = getConversationMessage(messageId);
    if (!message) return;
    resetMessageEdit();
    messageEdit.toolResultId = messageId;
    messageEdit.toolResultDraft = toolResultPlainText(message);
    renderChat();
    const textarea = $('#cc-editor-messages')?.querySelector(`[data-tool-result-for="${CSS.escape(messageId)}"] .cc-message-edit-input`);
    if (textarea) autoSize(textarea);
    textarea?.focus();
}
function cancelToolResultEdit() {
    resetToolResultEdit();
    renderChat();
}
function saveToolResultEdit(messageId) {
    const message = getConversationMessage(messageId);
    if (!message) return;
    message.toolResultOverride = messageEdit.toolResultDraft.trim();
    message.toolResultDisplay = message.toolResultOverride;
    resetToolResultEdit();
    renderChat();
    persist();
}
function saveMessageEdit(messageId) {
    const message = activeConversation()?.messages.find(item => item.id === messageId);
    if (!message) return;
    if (message.role !== 'assistant') {
        message.text = messageEdit.draft.trim();
        resetMessageEdit();
        renderChat();
        persist();
        return;
    }
    try {
        const sourceValues = copyFieldValues();
        const editedToolParse = parseCharacterDesignerToolCalls(messageEdit.draft);
        const editedTools = editedToolParse.calls.filter(call => !call.error);
        const parseFailures = editedToolParse.calls.filter(call => call.error).map(call => Object.assign(new Error(call.error.message), { detail: call.error.message }));
        const parsed = parseEdits(editedTools, sourceValues);
        const parsedLore = parseLorebookTools(editedTools, state.lorebook, state.loreEntryIds);
        // Report every bad call at once. Surfacing only the first turns fixing a
        // multi-call edit into one round trip per mistake.
        if (parseFailures.length || parsed.failures.length || parsedLore.failures.length) {
            const details = [...parseFailures, ...parsed.failures, ...parsedLore.failures].map(failure => failure?.detail || failure?.message || String(failure));
            throw Object.assign(new Error(details.join('\n')), { detail: [...new Set(details)].join('\n') });
        }
        const edits = parsed.edits;
        const before = snapshot();
        record(before);
        for (const edit of edits) {
            edit.messageId = messageId;
            applyLiveEdit(edit);
            addPendingEdit(edit);
        }
        const loreDiff = applyLorebookProposal(parsedLore, state.lorebook, state.loreEntryIds);
        const currentValues = copyFieldValues(getValue);
        const parsedReads = parseReadRequests(editedTools);
        const readResults = evaluateReadRequests(parsedReads.reads, currentValues, activeConversation()?.baseline);
        const loreReadResults = parsedLore.reads.map(read => loreReadResult(read, state.lorebook, state.loreEntryIds));
        const failures = [...parsedReads.failures, ...readResults.failures];
        message.raw = messageEdit.draft;
        message.text = stripXml(messageEdit.draft);
        message.reasoning = messageEdit.reasoning;
        message.diffs = [...edits, ...(loreDiff ? [loreDiff] : [])];
        message.toolXml = editedTools.map(block => block.xml).join('\n');
        message.toolResult = [edits.map(editContextResult).join('\n'), loreDiff ? loreSuccessResults(parsedLore) : '', readResults.results.join('\n'), loreReadResults.join('\n'), failures.map(toolFailureResult).join('\n')].filter(Boolean).join('\n');
        message.toolResultDisplay = message.toolResult;
        delete message.toolResultOverride;
        message.readResults = [...readResults.results, ...loreReadResults];
        if (failures.length) message.errors = failures.map(serializeToolFailure);
        else delete message.errors;
        delete message.error;
        updateKnownCardFields(activeConversation(), [
            ...edits.map(edit => edit.field),
            ...parsedReads.reads.map(read => read.id),
            ...failures.map(failure => failure?.proposal?.field),
        ]);
        resetMessageEdit();
        render();
        persist();
    } catch (error) {
        messageEdit.error = error?.detail || error?.message || String(error);
        renderChat();
    }
}
function messageBubbleHtml(message) {
    const reasoning = message.reasoning ? `<details class="cc-message-reasoning" ${resolveReasoningOpen(message) ? 'open' : ''}><summary>Reasoning</summary><div class="cc-message-reasoning-body">${formattedMessageText(message.reasoning, message.role, true)}</div></details>` : '';
    const toolStream = message.streaming && message.toolStream ? streamingToolHtml(message.toolStream) : '';
    const displayText = message.text || '';
    const canEdit = !message.streaming;
    const canEditAttachments = message.role === 'user' && !message.streaming;
    const canFork = canEditAttachments && !activeGenerationController;
    const editButton = canEdit ? '<button class="cc-message-edit menu_button" type="button" title="Edit"><i class="fa-solid fa-pencil"></i></button>' : '';
    const forkButton = canFork ? '<button class="cc-message-fork menu_button" type="button" title="Fork conversation from here" aria-label="Fork conversation from here"><i class="fa-solid fa-code-branch"></i></button>' : '';
    const attachments = imageAttachmentsHtml(message.attachments, { editable: canEditAttachments });
    const addAttachment = canEditAttachments ? '<button class="cc-message-attachment-add menu_button" type="button" title="Add images" aria-label="Add images"><i class="fa-solid fa-paperclip"></i></button>' : '';
    const actions = canEdit ? `<div class="cc-message-actions">${forkButton}${addAttachment}${editButton}</div>` : '';
    const errors = [...(message.errors || []), ...(message.error ? [message.error] : [])];
    const toolCall = !message.streaming ? toolCallSummaryHtml(message) : '';
    if (!(message.streaming || displayText || message.attachments?.length || canEditAttachments || message.reasoning || message.toolStream || message.toolXml || message.diffs?.length || errors.length)) return '';
    const canResume = activeConversation()?.pendingContinuation && activeConversation()?.messages.at(-1)?.id === message.id;
    const resume = canResume ? '<button class="cc-flow-continue menu_button" type="button"><i class="fa-solid fa-arrow-right"></i><span>Continue</span></button>' : '';
    return `<article class="cc-message ${message.role === 'user' ? 'cc-user-message' : ''} ${canEdit ? 'cc-message-has-edit' : ''} ${canEditAttachments ? 'cc-message-has-attachment-action' : ''} ${canFork ? 'cc-message-has-fork-action' : ''}" data-message-id="${message.id}">${actions}${reasoning}<div class="cc-message-text">${formattedMessageText(displayText, message.role)}</div>${attachments}${toolStream}${toolCall}${(message.diffs || []).map(diffHtml).join('')}${resume}</article>`;
}
function messageHtml(message) {
    if (messageEdit.id === message.id) {
        const editedMessage = getConversationMessage(messageEdit.id);
        const reasoning = editedMessage?.role === 'assistant'
            ? `<label class="cc-message-edit-label">Reasoning<textarea class="text_pole cc-message-edit-input cc-message-edit-reasoning-input" data-edit-part="reasoning" rows="1" spellcheck="false">${escapeHtml(messageEdit.reasoning)}</textarea></label>`
            : '';
        const label = editedMessage?.role === 'assistant' ? 'Response and tool calls' : 'Message';
        const roleClass = editedMessage?.role === 'user' ? ' cc-user-message' : '';
        const attachments = editedMessage?.role === 'user' ? imageAttachmentsHtml(editedMessage.attachments, { editable: true }) : '';
        const addAttachment = editedMessage?.role === 'user' ? '<button class="cc-message-attachment-add menu_button" type="button" title="Add images" aria-label="Add images"><i class="fa-solid fa-paperclip"></i></button>' : '';
        return `<article class="cc-message cc-message-editing${roleClass}" data-message-id="${editedMessage.id}"><div class="cc-message-edit-actions">${addAttachment}<button class="cc-message-edit-save menu_button" type="button" title="Confirm"><i class="fa-solid fa-check"></i></button><button class="cc-message-edit-cancel menu_button" type="button" title="Cancel"><i class="fa-solid fa-xmark"></i></button></div>${reasoning}<label class="cc-message-edit-label">${label}<textarea class="text_pole cc-message-edit-input" data-edit-part="response" rows="1" spellcheck="false">${escapeHtml(messageEdit.draft)}</textarea></label>${attachments}${messageEdit.error ? `<div class="cc-message-edit-error">${escapeHtml(messageEdit.error)}</div>` : ''}</article>`;
    }
    return `${messageBubbleHtml(message)}${toolResultBubbleHtml(message)}`;
}
// Only the shape messageHtml() emits while streaming can be updated in place. Once an
// edit button, diffs or errors are due, the article has to be rebuilt instead.
function canPatchStreamingMessage(message) {
    return Boolean(message.streaming) && messageEdit.id !== message.id
        && !message.diffs?.length && !message.errors?.length && !message.error;
}
function patchReasoning(article, anchor, message, reasoning, changed) {
    let details = article.querySelector(':scope > .cc-message-reasoning');
    if (!reasoning) { details?.remove(); return; }
    if (!details) {
        details = document.createElement('details');
        details.className = 'cc-message-reasoning';
        details.innerHTML = '<summary>Reasoning</summary><div class="cc-message-reasoning-body"></div>';
        anchor.before(details);
        changed = true;
    }
    bindReasoningToggle(details);
    const body = details.querySelector(':scope > .cc-message-reasoning-body');
    const shouldFollow = reasoningAutoFollow.get(body) !== false;
    if (changed) {
        if (body) body.innerHTML = formattedMessageText(reasoning, message.role, true);
    }
    // Streaming may continue after the user explicitly opens or closes reasoning, so
    // always resolve the open state from the message model instead of the live DOM.
    setReasoningDetailsOpen(details, resolveReasoningOpen(message));
    if (body && message.streaming && shouldFollow && details.open) {
        requestAnimationFrame(() => scrollReasoningIntoView(body));
    } else if (body) {
        requestAnimationFrame(() => updateReasoningFades(body));
    }
}
function patchToolStream(article, anchor, toolStream) {
    let pre = article.querySelector(':scope > .cc-tool-stream');
    if (!toolStream) { pre?.remove(); return; }
    if (!pre) {
        pre = document.createElement('div');
        pre.className = 'cc-tool-stream';
        pre.innerHTML = '<i class="fa-solid fa-wrench" aria-hidden="true"></i><span></span>';
        anchor.after(pre);
    }
    pre.querySelector('span').textContent = toolCallSummaryText(toolStream);
}
// Compared against what this message last rendered rather than against the DOM, so an
// unchanged part is skipped outright instead of being formatted and written identically.
function patchStreamingMessage(article, message) {
    if (!canPatchStreamingMessage(message)) return false;
    const textNode = article.querySelector(':scope > .cc-message-text');
    if (!textNode) return false;
    const rendered = streamRenderCache.get(message) ?? { reasoning: '', text: '', toolStream: '' };
    const reasoning = message.reasoning || '';
    const text = message.text || '';
    const toolStream = message.toolStream || '';
    patchReasoning(article, textNode, message, reasoning, reasoning !== rendered.reasoning);
    if (text !== rendered.text) textNode.innerHTML = formattedMessageText(text, message.role);
    if (toolStream !== rendered.toolStream) patchToolStream(article, textNode, toolStream);
    streamRenderCache.set(message, { reasoning, text, toolStream });
    return true;
}
// Streaming repaints only touch the message being written, and within it only the parts
// that actually changed, so a selection, a caret or an open <details> elsewhere in the
// transcript survives the response instead of being rebuilt ten times a second.
function renderStreamingMessage(message) {
    const messages = $('#cc-editor-messages');
    const existing = messages.querySelector(`.cc-message[data-message-id="${CSS.escape(message.id)}"]`);
    if (!existing) { renderChat(); return; }
    if (messages.scrollHeight - messages.scrollTop - messages.clientHeight >= 48) {
        streamMessageAutoFollow.set(message, false);
    }
    if (!patchStreamingMessage(existing, message)) {
        const html = messageHtml(message);
        if (html) existing.outerHTML = html; else existing.remove();
    }
    followStreamingMessage(messages, message);
}
function updateStreamingMessage(message, response, streamedReasoning = '') {
    const parsedReasoning = parseReasoningStream(response);
    const visibleResponse = parsedReasoning?.content ?? response;
    // The same growing response previously went through the XML parser twice per
    // streaming tick. Parse it once, without retaining every transient prefix.
    const toolParse = parseCharacterDesignerToolCalls(visibleResponse, { cache: false });
    message.raw = visibleResponse;
    message.text = streamedProse(visibleResponse, toolParse);
    message.toolStream = streamedToolText(visibleResponse, toolParse);
    message.reasoning = streamedReasoning || parsedReasoning?.reasoning || '';
    message.isThinking = Boolean(parsedReasoning?.isThinking);
}
function scheduleStreamRender(message, updateMessage) {
    if (streamRenderTimer) return;
    const wait = Math.max(0, STREAM_RENDER_INTERVAL - (performance.now() - lastStreamRender));
    streamRenderTimer = setTimeout(() => {
        streamRenderTimer = 0;
        lastStreamRender = performance.now();
        updateMessage();
        renderStreamingMessage(message);
    }, wait);
}
function conversationNavigationAnchors(messages) {
    // A response can be emitted in several assistant messages while tools run. Treat
    // that contiguous run as one turn, so navigation remains user, assistant, user.
    let previousRole = null;
    return [...messages.children].filter(message => {
        if (!message.matches('.cc-message[data-message-id]')) return false;
        const role = message.classList.contains('cc-user-message') ? 'user' : 'assistant';
        const isNewTurn = role !== previousRole;
        previousRole = role;
        return isNewTurn;
    });
}
function messageScrollTop(messages, message) {
    return messages.scrollTop + message.getBoundingClientRect().top - messages.getBoundingClientRect().top;
}
function followStreamingMessage(messages, message) {
    if (streamMessageAutoFollow.get(message) !== true) return;
    const article = messages.querySelector(`.cc-message[data-message-id="${CSS.escape(message.id)}"]`);
    if (!article) return;
    const messageTop = Math.max(0, messageScrollTop(messages, article));
    const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    messages.scrollTop = Math.min(maxScrollTop, messageTop);
    // Once the response fills the viewport, pin its beginning at the top. Further
    // streaming may grow below the viewport, but never pushes that beginning away.
    if (maxScrollTop >= messageTop - 1) streamMessageAutoFollow.set(message, false);
}
function updateMessageNavigationButtons() {
    const messages = $('#cc-editor-messages');
    const previous = $('#cc-editor-previous-message');
    const next = $('#cc-editor-next-message');
    if (!messages || !previous || !next) return;
    const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
    previous.disabled = messages.scrollTop <= 1;
    next.disabled = maxScrollTop <= 1 || messages.scrollTop >= maxScrollTop - 1;
}
function fastScrollToConversationMessage(messages, top) {
    cancelAnimationFrame(messageNavigationScrollFrame);
    const start = messages.scrollTop;
    const distance = top - start;
    if (Math.abs(distance) < 1) return;
    const startedAt = performance.now();
    const duration = 120;
    const step = now => {
        const progress = Math.min((now - startedAt) / duration, 1);
        // Ease out: it moves quickly, then settles cleanly on the message.
        messages.scrollTop = start + distance * (1 - (1 - progress) ** 3);
        if (progress < 1) messageNavigationScrollFrame = requestAnimationFrame(step);
        else updateMessageNavigationButtons();
    };
    messageNavigationScrollFrame = requestAnimationFrame(step);
}
function scrollToConversationMessage(direction) {
    const messages = $('#cc-editor-messages');
    if (!messages) return;
    const anchors = conversationNavigationAnchors(messages);
    const currentIndex = anchors.reduce((index, message, candidateIndex) => (
        messageScrollTop(messages, message) <= messages.scrollTop + MESSAGE_NAVIGATION_TOLERANCE ? candidateIndex : index
    ), 0);
    const target = anchors[currentIndex + direction];
    if (!target) return;
    fastScrollToConversationMessage(messages, Math.max(0, messageScrollTop(messages, target) - MESSAGE_NAVIGATION_OFFSET));
}
function bindChatEvents(messages) {
    if (boundChatContainers.has(messages)) return;
    boundChatContainers.add(messages);
    messages.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (!button || !messages.contains(button)) return;
        const message = button.closest('.cc-message');
        if (button.matches('.cc-diff-jump')) {
            if (button.dataset.lorebook !== undefined) snapToLoreEdit();
            else snapToFieldEdit(button.dataset.field);
        } else if (button.matches('.cc-tool-result-edit-save')) {
            saveToolResultEdit(button.closest('.cc-tool-result-message')?.dataset.toolResultFor);
        } else if (button.matches('.cc-tool-result-edit-cancel')) {
            cancelToolResultEdit();
        } else if (button.matches('.cc-tool-result-edit')) {
            beginToolResultEdit(button.closest('.cc-tool-result-message')?.dataset.toolResultFor);
        } else if (button.matches('.cc-message-edit-save')) {
            saveMessageEdit(message?.dataset.messageId);
        } else if (button.matches('.cc-message-edit-cancel')) {
            cancelMessageEdit();
        } else if (button.matches('.cc-message-edit')) {
            beginMessageEdit(message?.dataset.messageId);
        } else if (button.matches('.cc-message-fork')) {
            forkConversationAtMessage(message?.dataset.messageId);
        } else if (button.matches('.cc-image-attachment-delete')) {
            removeMessageAttachment(button);
        } else if (button.matches('.cc-message-attachment-add')) {
            openAttachmentPicker(message?.dataset.messageId);
        } else if (button.matches('.cc-flow-continue')) {
            resumeConversationFlow();
        }
    });
    messages.addEventListener('input', event => {
        const textarea = event.target instanceof Element ? event.target.closest('.cc-message-edit-input') : null;
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        if (textarea.closest('.cc-tool-result-message')) messageEdit.toolResultDraft = textarea.value;
        else if (textarea.dataset.editPart === 'reasoning') messageEdit.reasoning = textarea.value;
        else messageEdit.draft = textarea.value;
        messageEdit.error = '';
        autoSize(textarea);
    });
    messages.addEventListener('paste', event => {
        const textarea = event.target instanceof Element ? event.target.closest('.cc-user-message .cc-message-edit-input[data-edit-part="response"]') : null;
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
        if (!files.length) return;
        event.preventDefault();
        void uploadImageAttachments(files, textarea.closest('.cc-message')?.dataset.messageId);
    });
}
function chatNodeKey(node) {
    if (!(node instanceof HTMLElement)) return undefined;
    if (node.id) return node.id;
    if (node.dataset.messageId) return `message:${node.dataset.messageId}`;
    if (node.dataset.toolResultFor) return `result:${node.dataset.toolResultFor}`;
    return undefined;
}
function renderChat() {
    const messages = $('#cc-editor-messages'); const conversation = activeConversation();
    const keepAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
    const streamScrollMessage = (conversation?.messages || []).findLast(message => streamMessageAutoFollow.has(message));
    if (streamScrollMessage && !keepAtBottom) streamMessageAutoFollow.set(streamScrollMessage, false);
    const target = messages.cloneNode(false);
    target.innerHTML = (conversation?.messages || []).map(message => messageHtml(message)).join('');
    morphdom(messages, target, { childrenOnly: true, getNodeKey: chatNodeKey, onBeforeElUpdated: preserveRuntimeBindingAttributes });
    bindChatEvents(messages);
    messages.querySelectorAll('.cc-message-reasoning').forEach(details => {
        bindReasoningToggle(details);
        const messageId = details.closest('.cc-message')?.dataset.messageId;
        const message = messageId ? getConversationMessage(messageId) : null;
        if (!message?.streaming && streamRenderCache.has(message)) {
            const body = details.querySelector(':scope > .cc-message-reasoning-body');
            if (body && reasoningAutoFollow.get(body) !== false) requestAnimationFrame(() => scrollReasoningIntoView(body, true));
            streamRenderCache.delete(message);
        }
    });
    if (streamScrollMessage) {
        followStreamingMessage(messages, streamScrollMessage);
        if (!streamScrollMessage.streaming) streamMessageAutoFollow.delete(streamScrollMessage);
    } else if (keepAtBottom) {
        messages.scrollTop = messages.scrollHeight;
    }
    updateMessageNavigationButtons();
    $('#cc-editor-composer').disabled = false;
    $('#cc-editor-attach').disabled = Boolean(activeGenerationController) || uploadingAttachments;
    $('#cc-editor-send').disabled = uploadingAttachments && !activeGenerationController;
    const send = $('#cc-editor-send');
    const icon = send.querySelector('i');
    send.classList.toggle('cc-generating', Boolean(activeGenerationController));
    icon.className = activeGenerationController ? 'fa-solid fa-circle-stop' : 'fa-solid fa-paper-plane';
    send.title = activeGenerationController ? 'Stop generating' : 'Send';
    renderDraftAttachments();
}
function pendingHunks() {
    return [...($('#cc-editor-card')?.querySelectorAll('.cc-pending-hunk') || [])];
}
function pendingEditTargets() {
    const targets = [];
    for (const section of CARD_SECTIONS) {
        if (section.id === 'lorebook') {
            if (state.lorebookProposal) {
                const beforeIds = state.lorebookProposal.beforeIds || [];
                const currentIds = state.loreEntryIds || [];
                for (const entryId of currentIds) {
                    if (!beforeIds.includes(entryId)) {
                        targets.push({ key: `lorebook:new:${entryId}`, section: section.id, lorebook: true, entryId, added: true });
                        continue;
                    }
                    for (const property of ['name', 'keys', 'constant', 'content']) {
                        const pending = lorePendingChange(entryId, property);
                        if (!pending) continue;
                        for (const part of pendingDiffParts(pending).filter(item => item.type === 'hunk')) {
                            targets.push({ key: `lorebook:${entryId}:${property}:${part.index}`, section: section.id, lorebook: true, entryId, property, hunk: part.index });
                        }
                    }
                }
                const hasRemovedEntries = beforeIds.some(entryId => !currentIds.includes(entryId));
                if (!targets.some(target => target.lorebook) && hasRemovedEntries) targets.push({ key: 'lorebook:removed', section: section.id, lorebook: true });
            }
            continue;
        }
        for (const field of section.fields) {
            const pending = state.pending[field];
            if (!pending) continue;
            if (isCollection(field)) {
                const before = Array.isArray(pending.before) ? pending.before : [];
                const after = Array.isArray(pending.after) ? pending.after : [];
                for (let index = 0; index < Math.max(before.length, after.length); index++) {
                    const parts = pendingDiffParts({ before: String(before[index] ?? ''), after: String(after[index] ?? '') });
                    for (const part of parts.filter(item => item.type === 'hunk')) {
                        targets.push({ key: `field:${field}:${index}:${part.index}`, section: section.id, field, index, hunk: part.index });
                    }
                }
                continue;
            }
            for (const part of pendingDiffParts(pending).filter(item => item.type === 'hunk')) {
                targets.push({ key: `field:${field}:main:${part.index}`, section: section.id, field, index: null, hunk: part.index });
            }
        }
    }
    return targets;
}
function pendingTargetElement(target) {
    if (target.lorebook && target.entryId && target.property !== undefined) {
        return pendingHunks().find(hunk => {
            const field = hunk.closest('.cc-lore-pending-field');
            return field?.dataset.loreEntry === target.entryId
                && field?.dataset.loreProperty === target.property
                && Number(hunk.dataset.hunk) === target.hunk;
        }) || null;
    }
    return pendingHunks().find(hunk => {
        const field = hunk.closest('.cc-pending-field');
        const index = field?.dataset.index === undefined ? null : Number(field.dataset.index);
        return field?.dataset.field === target.field && index === target.index && Number(hunk.dataset.hunk) === target.hunk;
    }) || null;
}
function showCardPane() {
    const editor = $('#character-card-editor');
    if (!editor) return;
    editor.dataset.mobilePane = 'card';
    document.querySelectorAll('.cc-editor-mobile-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.pane === 'card'));
}
function scrollToPendingHunk(hunk) {
    const card = $('#cc-editor-card');
    if (!card || !hunk?.isConnected) return;
    showCardPane();
    requestAnimationFrame(() => {
        if (!hunk.isConnected) return;
        snappedHunk?.classList.remove('cc-pending-hunk-current');
        snappedHunk = hunk;
        snappedHunk.classList.add('cc-pending-hunk-current');
        const cardRect = card.getBoundingClientRect();
        const hunkRect = hunk.getBoundingClientRect();
        const field = hunk.closest('.cc-code-field');
        let projectedHunkTop = hunkRect.top;
        let projectedHunkHeight = hunkRect.height;

        // Long fields have their own capped scroll area. Moving only the card pane
        // cannot reveal a hunk clipped inside that field; it merely drives the pane
        // to its bottom. Scroll the nested field first and use the hunk's projected
        // position there when centering the outer pane.
        if (field && field.scrollHeight > field.clientHeight) {
            const fieldRect = field.getBoundingClientRect();
            const fieldCenterOffset = Math.max(8, (field.clientHeight - Math.min(hunkRect.height, field.clientHeight)) / 2);
            const unclampedFieldTop = field.scrollTop + hunkRect.top - fieldRect.top - fieldCenterOffset;
            const fieldTop = Math.min(Math.max(0, unclampedFieldTop), field.scrollHeight - field.clientHeight);
            projectedHunkTop -= fieldTop - field.scrollTop;
            projectedHunkHeight = Math.min(projectedHunkHeight, field.clientHeight);
            field.scrollTo({ top: fieldTop, behavior: 'smooth' });
        }

        const cardCenterOffset = Math.max(8, (card.clientHeight - Math.min(projectedHunkHeight, card.clientHeight)) / 2);
        const unclampedCardTop = card.scrollTop + projectedHunkTop - cardRect.top - cardCenterOffset;
        const cardTop = Math.min(Math.max(0, unclampedCardTop), Math.max(0, card.scrollHeight - card.clientHeight));
        card.scrollTo({ top: cardTop, behavior: 'smooth' });
        showHunkControls(hunk);
        positionPendingControls();
    });
}
function snapToFieldEdit(id) {
    switchCardSection(cardSectionByField.get(id));
    const target = pendingHunks().find(hunk => hunk.closest('.cc-pending-field')?.dataset.field === id);
    if (target) {
        const field = target.closest('.cc-pending-field');
        snappedEditKey = `field:${id}:${field?.dataset.index ?? 'main'}:${target.dataset.hunk}`;
        scrollToPendingHunk(target);
    }
}
function snapToLoreEdit(target = null) {
    showCardPane();
    switchCardSection('lorebook');
    if (state.lorebookProposal && !target) snappedEditKey = 'lorebook';
    const hunk = target ? pendingTargetElement(target) : null;
    if (hunk) {
        scrollToPendingHunk(hunk);
        return;
    }
    const element = target?.entryId
        ? document.getElementById(`cc-lore-entry-${target.entryId}`)
        : $('#cc-field-lorebook');
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus?.({ preventScroll: true });
}
function snapToPendingEdit(direction) {
    const targets = pendingEditTargets();
    if (!targets.length) return;
    const currentIndex = targets.findIndex(target => target.key === snappedEditKey);
    const nextIndex = currentIndex < 0
        ? (direction > 0 ? 0 : targets.length - 1)
        : (currentIndex + direction + targets.length) % targets.length;
    const target = targets[nextIndex];
    snappedEditKey = target.key;
    if (target.lorebook) {
        snapToLoreEdit(target);
        return;
    }
    showCardPane();
    switchCardSection(target.section);
    const hunk = pendingTargetElement(target);
    if (hunk) scrollToPendingHunk(hunk);
}
function renderPendingActions() {
    const pendingCount = Object.keys(state.pending).length + (state.lorebookProposal ? 1 : 0);
    const proposedEditCount = pendingEditTargets().length;
    const acceptAll = $('#cc-editor-accept-all');
    const rejectAll = $('#cc-editor-reject-all');
    const previousEdit = $('#cc-editor-previous-edit');
    const nextEdit = $('#cc-editor-next-edit');
    // AI changes are applied immediately, but remain pending so the user can
    // either keep all of them or revert all of them in one action.
    acceptAll.hidden = false;
    acceptAll.disabled = rejectAll.disabled = pendingCount === 0;
    previousEdit.disabled = nextEdit.disabled = proposedEditCount === 0;
    acceptAll.title = pendingCount ? `Accept changes in ${pendingCount} field${pendingCount === 1 ? '' : 's'}` : 'No changes to accept';
    rejectAll.title = pendingCount ? `Revert changes in ${pendingCount} field${pendingCount === 1 ? '' : 's'}` : 'No changes to revert';
    previousEdit.title = proposedEditCount ? `Previous applied edit (${proposedEditCount})` : 'No applied edits';
    nextEdit.title = proposedEditCount ? `Next applied edit (${proposedEditCount})` : 'No applied edits';
}
// The shared drawer handler opens this panel whether or not a character is selected,
// so there has to be something coherent to show when there is no card to edit.
function renderNoCharacter() {
    customInstructionsFocusSnapshot = null;
    void closeCustomInstructionsPopup();
    $('#cc-editor-name').textContent = 'No character selected';
    $('#cc-editor-card').innerHTML = '<div class="cc-editor-empty">Select a character to edit its card.</div>';
    $('#cc-editor-messages').innerHTML = '';
    for (const selector of ['#cc-editor-previous-edit', '#cc-editor-next-edit', '#cc-editor-previous-message', '#cc-editor-next-message', '#cc-editor-custom-instructions-button', '#cc-editor-accept-all', '#cc-editor-reject-all', '#cc-editor-history', '#cc-editor-new-chat', '#cc-editor-attach', '#cc-editor-send']) {
        $(selector).disabled = true;
    }
    $('#cc-editor-questioning-mode').disabled = false;
    $('#cc-editor-questioning-mode').value = getQuestioningMode();
    const composer = $('#cc-editor-composer');
    composer.value = '';
    composer.disabled = true;
    $('#cc-editor-draft-attachments').innerHTML = '';
    $('#cc-editor-draft-attachments').hidden = true;
    updateMessageNavigationButtons();
}
function render() {
    $('#cc-editor-name').textContent = currentCharacter()?.name || data().name || 'Character';
    $('#character-card-editor').style.setProperty('--cc-card-width', `${state.cardWidth}%`);
    // Undone by renderNoCharacter, which disables the whole header.
    $('#cc-editor-custom-instructions-button').disabled = $('#cc-editor-history').disabled = $('#cc-editor-new-chat').disabled = false;
    $('#cc-editor-questioning-mode').value = getQuestioningMode();
    renderCard(); renderChat();
    renderPendingActions();
    renderCustomInstructions();
    const composer = $('#cc-editor-composer'); composer.value = state.draft || ''; autoSize(composer);
}
function snapshotSection(label, value) {
    const text = String(value ?? '');
    return `${label}:\n${text}`;
}
function snapshotText(values = {}) {
    const sections = [];
    for (const { id, label } of FIELDS) {
        const value = Object.hasOwn(values, id) ? values[id] : liveValue(id);
        if (isCollection(id)) {
            const items = Array.isArray(value) ? value : [];
            if (!items.length) sections.push(`${label}:\n`);
            items.forEach((item, index) => sections.push(snapshotSection(fieldLabel(id, index), item)));
            continue;
        }
        sections.push(snapshotSection(label, value));
    }
    const book = Object.hasOwn(values, '__lorebook') ? values.__lorebook : state.lorebook;
    const ids = Object.hasOwn(values, '__loreEntryIds') ? values.__loreEntryIds : state.loreEntryIds;
    if (!book) sections.push('Character Book:\n(none)');
    else {
        sections.push(`Character Book:\n${JSON.stringify({ entries: book.entries.map((entry, index) => ({ entry_id: ids[index], name: loreEntryLabel(entry, index), enabled: entry.enabled, constant: entry.constant, keys: entry.keys, content_preview: String(entry.content || '').slice(0, 160) })) }, null, 2)}`);
    }
    return sections.join('\n\n');
}
function getQuestioningMode() {
    const value = accountStorage.getItem(CHARACTER_DESIGNER_MODE_KEY);
    return ['Adaptive', 'Interview', 'Autonomous'].includes(value) ? value : 'Adaptive';
}
async function selectRandomKeywords(parameters, signal) {
    const count = parameters.count;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be an integer from 1 through 100.');
    const response = await fetch('/api/character-designer/random-keywords', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ count }), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || 'Could not select keywords.');
    return result.keywords;
}
async function setAvatarFromAttachment(parameters, signal) {
    if (typeof parameters.message_id !== 'string' || !parameters.message_id.trim()) throw new Error('message_id must be a non-empty string.');
    if (typeof parameters.attachment_id !== 'string' || !parameters.attachment_id.trim()) throw new Error('attachment_id must be a non-empty string.');
    const message = getConversationMessage(parameters.message_id);
    const attachment = normalizeImageAttachments(message?.attachments).find(item => item.id === parameters.attachment_id);
    if (!attachment) throw new Error('The requested editor attachment no longer exists.');
    const image = await fetch(attachment.url, { signal });
    if (!image.ok) throw new Error(`Could not fetch the requested attachment (HTTP ${image.status}).`);
    const blob = await image.blob();
    if (!blob.type.startsWith('image/')) throw new Error('The requested attachment is not a supported image.');
    const form = new FormData();
    form.append('avatar', blob, attachment.title || 'avatar.png');
    form.append('avatar_url', currentCharacter()?.avatar || '');
    const upload = await fetch('/api/characters/edit-avatar', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form, signal });
    if (!upload.ok) throw new Error(await upload.text() || 'Could not save the character avatar.');
    saveCharacterDebounced();
    toastr.success('Avatar updated from editor attachment.', 'Character Designer');
    return 'Avatar updated.';
}
function registerCharacterDesignerTools() {
    if (ToolManager.getXmlScopeDefinitions(CHARACTER_DESIGNER_XML_SCOPE).length) return;
    for (const tool of CHARACTER_DESIGNER_TOOL_SPECS) {
        ToolManager.registerXmlScopeTool(CHARACTER_DESIGNER_XML_SCOPE, {
            name: tool.name,
            displayName: tool.name.replaceAll('_', ' '),
            description: tool.description,
            parameters: { type: 'object', properties: tool.properties, required: tool.required || [], additionalProperties: false },
            action: tool.action || (parameters => parameters),
        });
    }
}
function parseCharacterDesignerToolCalls(text, { cache = true } = {}) {
    const source = String(text || '');
    if (cache && toolParseCache.has(source)) {
        const cached = toolParseCache.get(source);
        // Refresh insertion order to keep frequently rendered messages resident.
        toolParseCache.delete(source);
        toolParseCache.set(source, cached);
        return cached;
    }
    const parsed = ToolManager.findAndParseXmlScopeCalls(CHARACTER_DESIGNER_XML_SCOPE, source);
    for (const segment of parsed.segments.filter(segment => segment.type === 'tool')) {
        const root = String(segment.raw_xml || '').trim().match(/^<([A-Za-z_][\w:.-]*)\b/);
        if (!root || String(segment.raw_xml || '').trim().toLowerCase().endsWith(`</${root[1].toLowerCase()}>`)) continue;
        segment.parse_error = {
            code: 'incomplete_tool_call',
            tool_name: segment.tool_call?.tool || segment.detected_tool_name,
            message: 'The XML tool call ended before its closing tag.',
        };
        segment.tool_call = null;
        parsed.hasErrors = true;
        parsed.shouldContinue = true;
    }
    const result = {
        parsed,
        calls: parsed.segments.filter(segment => segment.type === 'tool').map(segment => ({
            name: segment.tool_call?.tool || segment.detected_tool_name,
            xml: segment.raw_xml,
            args: segment.tool_call?.args || {},
            continue: segment.tool_call?.continue !== false,
            error: segment.parse_error || null,
            start: segment.startIndex,
            end: segment.endIndex,
        })),
    };
    if (cache) {
        toolParseCache.set(source, result);
        while (toolParseCache.size > TOOL_PARSE_CACHE_LIMIT) toolParseCache.delete(toolParseCache.keys().next().value);
    }
    return result;
}
function characterDesignerMetadata(conversation) {
    return {
        attachments: (conversation?.messages || []).flatMap(message => normalizeImageAttachments(message.attachments).map(attachment => ({
            message_id: message.id,
            attachment_id: attachment.id,
            title: attachment.title,
            image: true,
            playable_media_url: attachment.url,
        }))),
    };
}
function buildCharacterDesignerPrompt({ questioningMode = getQuestioningMode(), customInstructions = '', originalCard = {}, metadata = {} } = {}) {
    return renderCharacterDesignerPrompt({
        questioningMode,
        customInstructions,
        originalCard: snapshotText(originalCard),
        toolDefinitions: ToolManager.getXmlScopePrompt(CHARACTER_DESIGNER_XML_SCOPE),
        metadata,
        promptResource: characterDesignerPromptResource,
    });
}
function resolveToolField(label) {
    const normalized = normalizeCharacterDesignerFieldLabel(label);
    const alias = resolveCharacterDesignerFieldAlias(normalized);
    if (alias) {
        const field = fieldById.get(alias.id);
        return { field, id: alias.id, index: alias.index, label: fieldLabel(alias.id, alias.index) };
    }
    const field = FIELDS.find(item => item.label.toLowerCase() === normalized || item.id.toLowerCase() === normalized);
    if (field) return { field, id: field.id, index: null, label: field.label };
    return null;
}
function toolValue(block, name) {
    return block.args[name];
}
function hasToolArgument(block, name) {
    return Object.hasOwn(block.args, name);
}
function editToolFailure(code, detail, proposal = null, title = 'Card edit not applied') {
    return Object.assign(new Error(detail), { toolFailure: true, code, detail, proposal, tool: proposal?.tool, title });
}
function editStringArgument(block, name, proposal, { required = true } = {}) {
    if (!hasToolArgument(block, name)) {
        if (!required) return '';
        throw editToolFailure('missing-argument', `${name} is required for ${block.name}.`, proposal);
    }
    const value = toolValue(block, name);
    if (typeof value !== 'string') throw editToolFailure('invalid-argument', `${name} must be a string.`, proposal);
    return value;
}
function patchesOverlap(left, right) {
    if (left.rewrite || right.rewrite) return true;
    if (left.start === left.end && right.start === right.end) return left.start === right.start;
    if (left.start === left.end) return left.start > right.start && left.start < right.end;
    if (right.start === right.end) return right.start > left.start && right.start < left.end;
    return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}
function parseEditBatch(blocks, sourceValues = {}) {
    const baseValues = Object.fromEntries(FIELDS.map(({ id }) => [id, Object.hasOwn(sourceValues, id) ? sourceValues[id] : effectiveValue(id)]));
    const patchGroups = new Map();
    const mergedEdits = new Map();
    for (const block of blocks) {
        const initialProposal = { tool: block.name };
        const rawLabel = editStringArgument(block, 'field', initialProposal).trim();
        const resolved = resolveToolField(rawLabel);
        if (!resolved) throw editToolFailure('unknown-field', `No card field matches ${rawLabel || '(missing)'}.`, { tool: block.name, label: rawLabel }, 'Unknown card field');
        const { field, id, index, label } = resolved;
        const isRewrite = block.name === 'rewrite_card_field';
        if (isCollection(id) && index === null) {
            throw editToolFailure('invalid-field-type', `Use ${fieldLabel(id, 0)} or another numbered ${id === 'greetings' ? 'Greeting' : 'Example'} label; ${field.label} cannot be edited as one combined field.`, { tool: block.name, field: id, label }, `${field.label} edit not applied`);
        }
        if (!isRewrite && isNumberField(id)) {
            throw editToolFailure('invalid-field-type', `${field.label} is numeric and cannot be changed with a partial text edit. Use rewrite_card_field with a nonnegative integer.`, { tool: block.name, field: id, label }, `${field.label} edit not applied`);
        }
        const sourceValuesForField = baseValues[id];
        const collectionLength = Array.isArray(sourceValuesForField) ? sourceValuesForField.length : 0;
        if (index !== null && (index > collectionLength || (!isRewrite && index === collectionLength))) {
            const detail = index === collectionLength
                ? `${label} does not exist yet. Only rewrite_card_field can create the next sequential ${id === 'greetings' ? 'Greeting' : 'Example'}.`
                : `${label} is not available. Use the next sequential item after the last existing ${id === 'greetings' ? 'Greeting' : 'Example'}.`;
            throw editToolFailure('unknown-field', detail, { tool: block.name, field: id, label, index }, `${label} edit not applied`);
        }
        const source = normalizeLineEndings(index === null ? asText(sourceValuesForField) : collectionItemValue(sourceValuesForField, index));
        let proposal;
        let start;
        let end;
        let replacement;
        if (isRewrite) {
            const rewriteProposal = { tool: block.name, field: id, label, index, rewrite: true };
            const rawContent = normalizeLineEndings(editStringArgument(block, 'content', rewriteProposal));
            const numericContent = Number(rawContent.trim());
            if (isNumberField(id) && (!/^\d+$/.test(rawContent.trim()) || !Number.isSafeInteger(numericContent))) {
                throw editToolFailure('invalid-argument', `${field.label} must be a nonnegative integer.`, { tool: block.name, field: id, label, index, rewrite: true }, `${field.label} rewrite not applied`);
            }
            const content = isNumberField(id) ? rawContent.trim() : rawContent;
            proposal = { tool: block.name, field: id, label, index, rewrite: true, content, find: source, replace: content };
            start = 0;
            end = source.length;
            replacement = content;
        } else {
            let resolvedEdit;
            if (block.name === 'replace_card_text') {
                proposal = { tool: block.name, field: id, label, index, operation: 'replace' };
                const find = editStringArgument(block, 'find', proposal);
                const replace = editStringArgument(block, 'replace', proposal);
                Object.assign(proposal, { find, replace });
                resolvedEdit = resolveReplaceCardText(source, { find, replace });
            } else if (block.name === 'delete_card_span') {
                proposal = { tool: block.name, field: id, label, index, operation: 'delete-span' };
                const from = editStringArgument(block, 'from', proposal);
                const until = editStringArgument(block, 'until', proposal);
                Object.assign(proposal, { from, until });
                resolvedEdit = resolveDeleteCardSpan(source, { from, until });
            } else if (block.name === 'insert_card_text') {
                proposal = { tool: block.name, field: id, label, index, operation: 'insert' };
                const content = editStringArgument(block, 'content', proposal);
                const position = editStringArgument(block, 'position', proposal).trim();
                const anchor = editStringArgument(block, 'anchor', proposal, { required: false });
                Object.assign(proposal, { content, position, anchor });
                resolvedEdit = resolveInsertCardText(source, { content, position, anchor });
            } else {
                throw editToolFailure('invalid-tool', `Unsupported Character Designer edit tool: ${block.name}.`, { tool: block.name, field: id, label, index });
            }
            if (resolvedEdit.error) {
                const detail = resolvedEdit.candidates?.length
                    ? `${resolvedEdit.error} Candidate excerpts: ${resolvedEdit.candidates.join(' | ')}`
                    : `${resolvedEdit.error} Current ${field.label} was not changed.`;
                throw editToolFailure(resolvedEdit.code || 'invalid-argument', detail, proposal, `${field.label} edit not applied`);
            }
            start = resolvedEdit.start;
            end = resolvedEdit.end;
            replacement = resolvedEdit.replacement;
            proposal.matched = resolvedEdit.matched;
        }
        const patchKey = index === null ? id : `${id}:${index}`;
        const group = patchGroups.get(patchKey) || { id, index, label, source, patches: [], operations: [] };
        const fieldPatches = group.patches;
        const patch = { start, end, replacement, rewrite: isRewrite, order: fieldPatches.length };
        if (fieldPatches.some(existing => patchesOverlap(existing, patch))) {
            throw editToolFailure('overlapping-edits', `This edit overlaps another ${field.label} edit in the same tool response.`, proposal, `${field.label} edit not applied`);
        }
        fieldPatches.push(patch);
        group.operations.push(proposal);
        patchGroups.set(patchKey, group);
    }
    for (const group of patchGroups.values()) {
        let next = group.source;
        // At an equal boundary, apply the consuming patch before the insertion so
        // the later zero-width splice cannot be consumed by the replacement.
        for (const patch of [...group.patches].sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start) || b.order - a.order)) {
            next = next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
        }
        const edit = mergedEdits.get(group.id) || { field: group.id, before: deepCopy(baseValues[group.id]), after: deepCopy(baseValues[group.id]), operations: [], id: uuidv4() };
        if (group.index === null) {
            edit.after = isCollection(group.id) ? valueFromText(group.id, next) : normalizeFieldStateValue(group.id, next);
        } else {
            const values = Array.isArray(edit.after) ? [...edit.after] : [];
            values[group.index] = next;
            edit.after = values;
        }
        edit.operations.push(...group.operations);
        mergedEdits.set(group.id, edit);
    }
    return [...mergedEdits.values()];
}
function parseEdits(calls, sourceValues = {}) {
    const blocks = toolCallsOfKind(calls, 'edit');
    const accepted = [];
    const failures = [];
    let edits = [];
    for (const block of blocks) {
        try {
            const combined = parseEditBatch([...accepted, block], sourceValues);
            accepted.push(block);
            edits = combined;
        } catch (error) {
            error.rawTool = block.xml;
            failures.push(error);
        }
    }
    return { edits, failures };
}
function parseLoreValue(property, raw) {
    if (property === 'constant') {
        if (typeof raw !== 'boolean') throw new Error(`${lorePropertyLabel(property)} must be a boolean.`);
        return raw;
    }
    if (property === 'keys') {
        if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) throw new Error(`${lorePropertyLabel(property)} must be an array of strings.`);
        const keys = raw.map(item => item.trim());
        if (keys.some(item => !item)) throw new Error(`${lorePropertyLabel(property)} must not contain empty strings.`);
        return keys;
    }
    if (typeof raw !== 'string') throw new Error(`${lorePropertyLabel(property)} must be a string.`);
    return normalizeLineEndings(raw);
}
function parseLorebookTools(calls, sourceBook, sourceIds) {
    let workingBook = sourceBook ? deepCopy(sourceBook) : null;
    const workingIds = [...(sourceIds || [])];
    const changes = [];
    const successes = [];
    const reads = [];
    const failures = [];
    const findEntry = entryId => workingIds.indexOf(entryId);
    const blocks = toolCallsOfKind(calls, 'lore');
    for (const block of blocks) {
        try {
            if (block.name === 'read_lorebook') {
                if (Object.keys(block.args || {}).length) throw Object.assign(new Error('read_lorebook does not accept arguments.'), { code: 'invalid-argument' });
                reads.push({ kind: 'book', block });
                continue;
            }
            const hasEntryId = hasToolArgument(block, 'entry_id');
            const rawEntryId = toolValue(block, 'entry_id');
            if (rawEntryId !== undefined && typeof rawEntryId !== 'string') throw Object.assign(new Error('entry_id must be a string.'), { code: 'invalid-argument' });
            const entryId = String(rawEntryId ?? '').trim();
            const supplied = [...LORE_ENTRY_PROPERTIES].filter(property => hasToolArgument(block, property));
            if (block.name === 'edit_lorebook_entry' && !hasEntryId) {
                if (!supplied.length) throw Object.assign(new Error('edit_lorebook_entry must include at least one of name, content, keys, or constant.'), { code: 'missing-argument' });
                workingBook ||= createLorebook();
                const newId = uuidv4();
                const entry = normalizeLoreEntry();
                for (const property of supplied) entry[property] = parseLoreValue(property, toolValue(block, property));
                if (!entry.name && !entry.comment) entry.name = `Entry ${workingBook.entries.length + 1}`;
                workingBook.entries.push(entry);
                workingIds.push(newId);
                const change = `Added ${loreEntryLabel(entry, workingBook.entries.length - 1)}`;
                changes.push(change);
                successes.push({ tool: block.name, change });
                continue;
            }
            if (!workingBook) throw Object.assign(new Error('This card has no Character Book.'), { code: 'unknown-entry' });
            const index = findEntry(entryId);
            if (index < 0) throw Object.assign(new Error(`Unknown lorebook entry_id: ${entryId || '(missing)'}`), { code: 'unknown-entry' });
            const entry = workingBook.entries[index]; const label = loreEntryLabel(entry, index);
            if (block.name === 'delete_lorebook_entry') {
                workingBook.entries.splice(index, 1);
                workingIds.splice(index, 1);
                const change = `Deleted ${label}`;
                changes.push(change);
                successes.push({ tool: block.name, change });
                continue;
            }
            if (!supplied.length) throw Object.assign(new Error('edit_lorebook_entry must include at least one of name, content, keys, or constant.'), { code: 'missing-argument' });
            for (const property of supplied) {
                entry[property] = parseLoreValue(property, toolValue(block, property));
            }
            const change = `Edited ${label}`;
            changes.push(change);
            successes.push({ tool: block.name, change });
        } catch (error) {
            failures.push(Object.assign(error, { toolFailure: true, code: error.code || 'invalid-argument', tool: block.name, title: 'Character Book tool not applied', detail: error.message, rawTool: block.xml, retryable: true }));
        }
    }
    return { changes, successes, reads, failures, afterBook: workingBook, afterIds: workingIds, toolXml: blocks.map(block => block.xml).join('\n') };
}
function loreSuccessResults(parsedLore) {
    return (parsedLore.successes || []).map(success => `<result>\n<tool>${xmlText(success.tool)}</tool>\n<status>success</status>\n<field>Character Book</field>\n<change>${xmlText(success.change)}</change>\n</result>`).join('\n');
}
function loreReadResult(read, book, ids) {
    const result = {
        entries: (book?.entries || []).map((entry, index) => ({
            entry_id: ids[index],
            name: entry.name || entry.comment || '',
            enabled: entry.enabled,
            constant: entry.constant,
            keys: entry.keys || [],
            content: entry.content || '',
        })),
    };
    return `<result>\n<tool>read_lorebook</tool>\n<status>success</status>\n<character_book>${xmlText(JSON.stringify(result, null, 2))}</character_book>\n</result>`;
}
function applyLorebookProposal(parsedLore, beforeBook, beforeIds) {
    if (!parsedLore.changes.length) return null;
    const diff = {
        id: uuidv4(),
        lorebook: true,
        label: 'Character Book',
        before: deepCopy(beforeBook),
        beforeIds: deepCopy(beforeIds),
        after: deepCopy(parsedLore.afterBook),
        afterIds: deepCopy(parsedLore.afterIds),
        changes: deepCopy(parsedLore.changes),
        rawTool: parsedLore.toolXml,
    };
    state.lorebookProposal ||= {
        id: uuidv4(),
        before: deepCopy(beforeBook),
        beforeIds: deepCopy(beforeIds),
    };
    state.lorebook = deepCopy(parsedLore.afterBook);
    state.loreEntryIds = deepCopy(parsedLore.afterIds);
    const beforeEntries = beforeBook?.entries || [];
    for (const [index, entryId] of state.loreEntryIds.entries()) {
        const beforeIndex = beforeIds.indexOf(entryId);
        const bodyChanged = beforeIndex >= 0 && (
            String(beforeEntries[beforeIndex]?.content || '') !== String(state.lorebook.entries[index]?.content || '') ||
            Boolean(beforeEntries[beforeIndex]?.constant) !== Boolean(state.lorebook.entries[index]?.constant)
        );
        if ((beforeIndex < 0 || bodyChanged) && !state.expandedLoreEntries.includes(entryId)) state.expandedLoreEntries.push(entryId);
    }
    updateLorebookProposalAfter();
    writeLorebookToCard();
    // Proposal state must reach account storage before a page reload can interrupt
    // the debounced character save.
    persistWorkspace();
    return diff;
}
function xmlText(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function sectionValue(values, id, index = null) {
    const value = Object.hasOwn(values || {}, id) ? values[id] : liveValue(id);
    return index === null ? asText(value) : collectionItemValue(value, index);
}
function contextBody(label, value, start = 0, end = null) {
    const lines = String(value ?? '').split('\n');
    const last = end === null ? lines.length : Math.min(lines.length, end);
    return `${label}:\n${lines.slice(start, last).join('\n')}`;
}
function contextResult(label, value, start = 0, end = null) {
    return `<context>\n${xmlText(contextBody(label, value, start, end))}\n</context>`;
}
function surroundingContextRanges(firstChangedLine, lastChangedLine, lineCount) {
    if (lastChangedLine - firstChangedLine + 1 <= MAX_TOOL_CONTEXT_CHANGED_LINES) {
        return [{ start: Math.max(0, firstChangedLine - 1), end: Math.min(lineCount, lastChangedLine + 2) }];
    }
    return [
        { start: Math.max(0, firstChangedLine - 1), end: Math.min(lineCount, firstChangedLine + 6) },
        { start: Math.max(0, lastChangedLine - 5), end: Math.min(lineCount, lastChangedLine + 2) },
    ];
}
function editTargetContext(edit, operation = null) {
    const index = operation?.index ?? null;
    const label = operation?.label || fieldLabel(edit.field, index);
    const after = sectionValue({ [edit.field]: edit.after }, edit.field, index);
    const afterLines = String(after).split('\n');
    const ranges = pendingDiffParts({
        before: sectionValue({ [edit.field]: edit.before }, edit.field, index),
        after,
    })
        .filter(part => part.type === 'hunk')
        .flatMap(part => {
            const firstChangedLine = lineAt(after, part.afterStart);
            const lastChangedLine = lineAt(after, Math.max(part.afterStart, part.afterEnd - 1));
            return surroundingContextRanges(firstChangedLine, lastChangedLine, afterLines.length);
        })
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push(range);
    }
    const context = merged.length
        ? merged.map(range => contextResult(label, after, range.start, range.end)).join('\n')
        : contextResult(label, after, 0, Math.min(afterLines.length, 3));
    return context;
}
function editContextResult(edit) {
    const operations = edit.operations || [];
    const statuses = operations.map(item => `<result>\n<tool>${xmlText(item.tool || (item.rewrite ? 'rewrite_card_field' : 'replace_card_text'))}</tool>\n<status>success</status>\n<field>${xmlText(item.label || fieldLabel(edit.field, item.index ?? null))}</field>\n</result>`).join('\n');
    const targets = [];
    const seen = new Set();
    for (const operation of operations.length ? operations : [null]) {
        const key = operation?.index ?? 'field';
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(operation);
    }
    const contexts = targets.map(operation => editTargetContext(edit, operation)).join('\n');
    return [statuses, contexts].filter(Boolean).join('\n');
}
function parseReadRequests(calls) {
    const reads = [];
    const failures = [];
    for (const block of toolCallsOfKind(calls, 'read')) {
        const rawField = toolValue(block, 'field');
        if (typeof rawField !== 'string') {
            failures.push(Object.assign(new Error('field must be a string.'), {
                toolFailure: true,
                code: hasToolArgument(block, 'field') ? 'invalid-argument' : 'missing-argument',
                tool: 'read_card_section',
                title: 'Card section read failed',
                detail: 'field must be a string.',
                rawTool: block.xml,
            }));
            continue;
        }
        const rawLabel = rawField.trim();
        const resolved = resolveToolField(rawLabel);
        if (!resolved) {
            failures.push(Object.assign(new Error(`Unknown card field: ${rawLabel.toLowerCase() || '(missing)'}`), {
                toolFailure: true,
                code: 'unknown-field',
                tool: 'read_card_section',
                title: 'Card section read failed',
                detail: `No card section matches ${rawLabel || '(missing)'}.`,
                rawTool: block.xml,
            }));
            continue;
        }
        if (resolved.index !== null) {
            const values = effectiveValue(resolved.id);
            if (!Array.isArray(values) || resolved.index >= values.length) {
                failures.push(Object.assign(new Error(`${resolved.label} is not available in the current card.`), {
                    toolFailure: true,
                    code: 'unknown-field',
                    tool: 'read_card_section',
                    title: 'Card section read failed',
                    detail: `${resolved.label} is not available in the current card.`,
                    proposal: { field: resolved.id, label: resolved.label, index: resolved.index, tool: 'read_card_section' },
                    rawTool: block.xml,
                }));
                continue;
            }
        }
        reads.push({ ...resolved, block });
    }
    return { reads, failures };
}
function readResult(read, values = {}) {
    return `<result>\n<tool>read_card_section</tool>\n<status>success</status>\n<field>${xmlText(read.label)}</field>\n${contextResult(read.label, sectionValue(values, read.id, read.index))}\n</result>`;
}
function evaluateReadRequests(reads, currentValues = {}, baselineValues = {}) {
    const results = [];
    const failures = [];
    for (const read of reads) {
        const current = sectionValue(currentValues, read.id, read.index);
        const original = sectionValue(baselineValues, read.id, read.index);
        if (current === original) {
            results.push(`${read.label}${UNCHANGED_READ_RESULT_SUFFIX}`);
            continue;
        }
        results.push(readResult(read, currentValues));
    }
    return { results, failures };
}
function stripXml(text) {
    return parseCharacterDesignerToolCalls(text).parsed.segments
        .filter(segment => segment.type === 'text')
        .map(segment => segment.text)
        .join('')
        .trim();
}
// A stopped response can end mid-tag. Replaying that fragment as history invites the
// model to treat it as a real call, so cut back to the last block that closed.
function withoutIncompleteToolXml(text) {
    const source = String(text || '');
    const incomplete = parseCharacterDesignerToolCalls(source).calls.find(call => call.error?.code === 'incomplete_tool_call');
    return incomplete ? source.slice(0, incomplete.start).trimEnd() : source;
}
function failureContextResult(error) {
    const proposal = error?.proposal;
    if (!proposal || proposal.rewrite || !fieldById.has(proposal.field)) return '';
    const index = proposal.index ?? null;
    const label = proposal.label || fieldLabel(proposal.field, index);
    const current = normalizeLineEndings(sectionValue({}, proposal.field, index));
    const lines = current.split('\n');
    const requested = [proposal.find, proposal.from, proposal.until, proposal.anchor]
        .map(normalizeLineEndings)
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)
        .find(value => current.includes(value)) || '';
    const position = requested ? current.indexOf(requested) : -1;
    const matchedLength = requested.length;
    if (position < 0) return '';
    const firstLine = lineAt(current, position);
    const lastLine = lineAt(current, position + Math.max(0, matchedLength - 1));
    return surroundingContextRanges(firstLine, lastLine, lines.length)
        .map(range => contextResult(label, current, range.start, range.end))
        .join('\n');
}
function toolFailureResult(error) {
    const detail = error?.detail || error?.message || 'The tool call could not be validated.';
    const field = error?.proposal?.label ? `\n<field>${xmlText(error.proposal.label)}</field>` : '';
    const tool = error?.tool || error?.proposal?.tool || (error?.proposal?.rewrite ? 'rewrite_card_field' : 'replace_card_text');
    const currentContext = failureContextResult(error);
    const contextInstruction = currentContext
        ? 'Correct only this failed call using the nearby current text supplied below.'
        : 'Correct only this failed call. Use read_card_section first if you need current text.';
    const code = error?.code ? `\n<code>${xmlText(error.code)}</code>` : '';
    return `<result>\n<tool>${xmlText(tool)}</tool>\n<status>error</status>${field}${code}\n<error>${xmlText(detail)}</error>\n<instruction>This call was not applied. Other valid calls in the response were kept. ${contextInstruction} Exact anchors must occur once; use rewrite_card_field only for a genuine whole-field rewrite.</instruction>\n</result>${currentContext ? `\n${currentContext}` : ''}`;
}
async function promptHistory(conversation, excludeId) {
    const prompt = [];
    const resultRole = ['assistant', 'user', 'system'].includes(oai_settings.tool_result_role) ? oai_settings.tool_result_role : 'system';
    for (const message of conversation.messages) {
        if (message.id === excludeId) continue;
        const text = message.role === 'assistant'
            ? rawMessageText(message)
            : [message.text, message.cardChangeContext].filter(Boolean).join('\n');
        const content = await promptContentWithImages(message, text);
        prompt.push({ role: message.role, content });
        if (message.role === 'assistant' && message.toolResultDisplay) prompt.push({ role: resultRole, content: message.toolResultDisplay });
    }
    return prompt;
}
function serializeToolFailure(error) {
    return {
        code: error?.code,
        detail: error?.detail,
        message: error?.message || String(error),
        proposal: error?.proposal,
        rawTool: error?.rawTool || '',
        retryable: error?.retryable,
        tool: error?.tool,
    };
}
function applyCardToolCalls(calls, generationValues, conversation, messageId, { additionalChanges = [], failures = [] } = {}) {
    const parsedEdits = parseEdits(calls, generationValues);
    const parsedReads = parseReadRequests(calls);
    failures.push(...parsedEdits.failures, ...parsedReads.failures);
    const edits = parsedEdits.edits.filter(edit => {
        if (JSON.stringify(getValue(edit.field)) === JSON.stringify(edit.before)) return true;
        const proposal = edit.operations?.[0];
        failures.push(Object.assign(new Error(`${fieldLabel(edit.field)} changed while this response was being generated.`), {
            toolFailure: true,
            code: 'stale-field',
            tool: proposal?.tool,
            title: `${fieldLabel(edit.field)} edit not applied`,
            detail: `The current ${fieldLabel(edit.field)} no longer matches the snapshot used for this tool call.`,
            proposal,
            rawTool: toToolXml(edit),
        }));
        return false;
    });
    const changeContexts = [...edits.map(editContextResult), ...additionalChanges];
    if (changeContexts.length) {
        const before = snapshot();
        record(before);
        checkpoint('AI changes', before, changeContexts.join('\n'));
    }
    for (const edit of edits) {
        edit.messageId = messageId;
        applyLiveEdit(edit);
        addPendingEdit(edit);
    }
    const readResults = evaluateReadRequests(parsedReads.reads, copyFieldValues(getValue), conversation.baseline);
    failures.push(...readResults.failures);
    updateKnownCardFields(conversation, [
        ...edits.map(edit => edit.field),
        ...parsedReads.reads.map(read => read.id),
        ...failures.map(failure => failure?.proposal?.field),
    ]);
    return { edits, parsedReads, readResults, failures, contextResults: [...edits.map(editContextResult), ...readResults.results] };
}
async function generateAssistant(conversation, retriesRemaining = MAX_TOOL_RETRIES) {
    delete conversation.pendingContinuation;
    const generationValues = copyFieldValues();
    const generationBook = deepCopy(state.lorebook);
    const generationLoreIds = deepCopy(state.loreEntryIds);
    const pendingMessage = { id: uuidv4(), role: 'assistant', text: '', reasoning: '', toolStream: '', diffs: [], streaming: true, isThinking: false, reasoningOpenOverride: null };
    const messages = $('#cc-editor-messages');
    const shouldAutoFollow = !messages || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
    streamMessageAutoFollow.set(pendingMessage, shouldAutoFollow);
    conversation.messages.push(pendingMessage);
    activeGenerationController = new AbortController();
    renderChat();
    let response = '';
    let streamedReasoning = '';
    let continueGeneration = false;
    try {
        const prompt = await promptHistory(conversation, pendingMessage.id);
        const data = await generateRawData({ prompt, systemPrompt: buildCharacterDesignerPrompt({ customInstructions: state.customInstructions, originalCard: conversation.baseline, metadata: characterDesignerMetadata(conversation) }), quietToLoud: true, stream: true, signal: activeGenerationController.signal, substituteMacros: false });
        if (typeof data === 'function') {
            for await (const chunk of data()) {
                response = chunk.text || response;
                streamedReasoning = chunk.state?.reasoning || streamedReasoning;
                scheduleStreamRender(pendingMessage, () => updateStreamingMessage(pendingMessage, response, streamedReasoning));
            }
        } else {
            response = cleanUpMessage({ getMessage: extractMessageFromData(data), isImpersonate: false, isContinue: false, displayIncompleteSentences: true, includeUserPromptBias: false, trimNames: false, trimWrongNames: false });
        }
        const parsedReasoning = parseReasoningStream(response);
        const visibleResponse = parsedReasoning?.content ?? response;
        pendingMessage.raw = visibleResponse;
        pendingMessage.reasoning = streamedReasoning || pendingMessage.reasoning || parsedReasoning?.reasoning || '';
        pendingMessage.isThinking = Boolean(parsedReasoning?.isThinking);
        const scopedTools = parseCharacterDesignerToolCalls(visibleResponse);
        const toolCalls = scopedTools.calls.filter(call => !call.error);
        // ToolManager owns validation and invocation.  The editor-specific
        // proposal adapters below consume these parsed arguments; they never
        // parse a newly generated XML block themselves.
        const contextCalls = toolCallsOfKind(toolCalls, 'context');
        const invocationResults = new Map(await Promise.all(contextCalls.map(async call => [call, await ToolManager.invokeXmlScopeTool(
            CHARACTER_DESIGNER_XML_SCOPE, call.name, call.args, { signal: activeGenerationController.signal },
        )])));
        const parserFailures = scopedTools.calls.filter(call => call.error).map(call => Object.assign(new Error(call.error.message), {
            toolFailure: true, code: call.error.code === 'missing_required_argument' ? 'missing-argument' : (call.error.code || 'invalid-tool-call'), tool: call.name, title: 'Tool call not applied', detail: call.error.message, rawTool: call.xml, retryable: true,
        }));
        const parsedLore = parseLorebookTools(toolCalls, generationBook, generationLoreIds);
        const contextToolResults = contextCalls.map(call => {
            const result = invocationResults.get(call);
            const target = call.name === 'random_keywords' ? 'Keyword selection' : 'Avatar';
            return result instanceof Error
                ? { tool: call.name, status: 'error', target, error: result.message }
                : { tool: call.name, status: 'success', target, output: String(result) };
        });
        const contextResults = contextToolResults.map(result => result.status === 'error'
            ? `<result>\n<tool>${result.tool}</tool>\n<status>error</status>\n<target>${result.target}</target>\n<error>${xmlText(result.error)}</error>\n<instruction>This call was not applied; no mutation occurred.</instruction>\n</result>`
            : `<result>\n<tool>${result.tool}</tool>\n<status>success</status>\n<target>${result.target}</target>\n<output>${xmlText(result.output)}</output>\n</result>`);
        let loreChanges = parsedLore.changes;
        const initialFailures = [...parserFailures, ...parsedLore.failures];
        if (JSON.stringify(liveCharacterBook()) !== JSON.stringify(generationBook) || JSON.stringify(state.loreEntryIds) !== JSON.stringify(generationLoreIds)) {
            if (loreChanges.length) initialFailures.push(Object.assign(new Error('The Character Book changed while this response was being generated.'), { toolFailure: true, code: 'stale-field', tool: 'edit_lorebook_entry', title: 'Character Book edits not applied', detail: 'The live Character Book no longer matches the snapshot used by these calls.', retryable: true }));
            loreChanges = [];
        }
        const cardTools = applyCardToolCalls(toolCalls, generationValues, conversation, pendingMessage.id, {
            additionalChanges: loreChanges.length ? [`Character Book proposal: ${loreChanges.join('; ')}`] : [],
            failures: initialFailures,
        });
        const { edits, parsedReads, readResults } = cardTools;
        let failures = groupToolFailures(cardTools.failures);
        contextResults.push(...cardTools.contextResults);
        if (loreChanges.length) contextResults.push(loreSuccessResults(parsedLore));
        const loreDiff = loreChanges.length ? applyLorebookProposal(parsedLore, generationBook, generationLoreIds) : null;
        const loreReadResults = parsedLore.reads.map(read => loreReadResult(read, generationBook, generationLoreIds));
        contextResults.push(...loreReadResults);
        const requestedContinuation = scopedTools.parsed.shouldContinue && scopedTools.calls.length > 0;
        continueGeneration = requestedContinuation && retriesRemaining > 0;
        conversation.pendingContinuation = requestedContinuation && retriesRemaining === 0;
        pendingMessage.text = streamedProse(visibleResponse, scopedTools);
        pendingMessage.diffs = [...edits, ...(loreDiff ? [loreDiff] : [])];
        pendingMessage.toolXml = toolCalls.map(call => call.xml).join('\n');
        pendingMessage.contextToolResults = contextToolResults;
        pendingMessage.toolResult = contextResults.join('\n');
        pendingMessage.toolResultDisplay = [...contextResults, ...(loreDiff ? [`Character Book proposal: ${loreChanges.join('; ')}`] : [])].join('\n');
        pendingMessage.readResults = [...readResults.results, ...loreReadResults];
        if (failures.length) {
            pendingMessage.errors = failures.map(serializeToolFailure);
            const failureResults = failures.map(toolFailureResult).join('\n');
            pendingMessage.toolResult = [pendingMessage.toolResult, failureResults].filter(Boolean).join('\n');
            pendingMessage.toolResultDisplay = [pendingMessage.toolResultDisplay, failureResults].filter(Boolean).join('\n');
        }
        pendingMessage.toolStream = '';
    } catch (error) {
        if (error?.name === 'AbortError' || activeGenerationController?.signal.aborted) {
            const parsedReasoning = parseReasoningStream(response);
            const visibleResponse = withoutIncompleteToolXml(parsedReasoning?.content ?? response);
            pendingMessage.raw = visibleResponse;
            pendingMessage.reasoning = streamedReasoning || pendingMessage.reasoning || parsedReasoning?.reasoning || '';
            // Any call that finished before the stop is still a usable proposal, and the
            // truncated tail is dropped rather than replayed to the model as history.
            // Salvage is best effort: a half-received response is the likeliest thing to
            // parse strangely, and failing to rescue it must not lose the stop itself.
            let salvaged = [];
            let salvagedParse = null;
            try {
                salvagedParse = parseCharacterDesignerToolCalls(visibleResponse);
                const salvagedTools = salvagedParse.calls
                    .filter(call => !call.error && ['edit', 'read'].includes(characterDesignerToolByName.get(call.name)?.kind));
                const cardTools = applyCardToolCalls(salvagedTools, generationValues, conversation, pendingMessage.id);
                salvaged = cardTools.edits;
                const failureResults = cardTools.failures.map(toolFailureResult);
                pendingMessage.toolXml = salvagedTools.map(call => call.xml).join('\n');
                pendingMessage.toolResult = pendingMessage.toolResultDisplay = [...cardTools.contextResults, ...failureResults].join('\n');
                pendingMessage.readResults = cardTools.readResults.results;
                if (cardTools.failures.length) pendingMessage.errors = cardTools.failures.map(serializeToolFailure);
            } catch (salvageError) {
                console.error('Character card editor: could not recover edits from the stopped response.', salvageError);
                salvaged = [];
            }
            pendingMessage.text = streamedProse(visibleResponse, salvagedParse);
            pendingMessage.diffs = salvaged;
            // Say where the stop came from: this generation also aborts when the user
            // stops an unrelated one in the main chat, which is otherwise baffling.
            if (!pendingMessage.text && !salvaged.length) {
                pendingMessage.text = abortedByUser ? 'Generation stopped.' : 'Generation was stopped elsewhere in SillyTavern.';
            }
        } else {
            const parsedReasoning = parseReasoningStream(response);
            pendingMessage.raw = parsedReasoning?.content ?? response;
            pendingMessage.reasoning = streamedReasoning || pendingMessage.reasoning || parsedReasoning?.reasoning || '';
            const errorResponse = parsedReasoning?.content ?? response;
            const rawTool = streamedToolText(errorResponse, parseCharacterDesignerToolCalls(errorResponse)) || pendingMessage.toolStream || '';
            pendingMessage.toolXml = rawTool;
            pendingMessage.error = { ...serializeToolFailure(error), rawTool };
            if (error?.toolFailure) {
                pendingMessage.toolResult = pendingMessage.toolResultDisplay = toolFailureResult(error);
                updateKnownCardFields(conversation, [error?.proposal?.field]);
                continueGeneration = retriesRemaining > 0;
                conversation.pendingContinuation = retriesRemaining === 0;
            }
        }
    } finally {
        // A queued repaint would replace the finished message without its listeners.
        if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = 0; }
        pendingMessage.streaming = false;
        pendingMessage.isThinking = false;
        pendingMessage.toolStream = '';
        activeGenerationController = null;
    }
    render(); persistWorkspace();
    if (pendingExternalCardRefresh) {
        pendingExternalCardRefresh = false;
        refreshExternalCardState();
    }
    const continuedConversation = state?.conversations.find(item => item.id === conversation.id);
    if (continueGeneration && continuedConversation) await generateAssistant(continuedConversation, retriesRemaining - 1);
}
function stopGeneration() {
    if (!activeGenerationController) return;
    abortedByUser = true;
    activeGenerationController.abort();
}

export function isCharacterDesignerGenerating() {
    return Boolean(activeGenerationController);
}
function resumeConversationFlow() {
    if (!state || activeGenerationController) return;
    const conversation = activeConversation();
    if (!conversation?.pendingContinuation) return;
    delete conversation.pendingContinuation;
    abortedByUser = false;
    persist();
    void generateAssistant(conversation);
}
async function send() {
    // Deliberately not a stop toggle: the composer's Enter key routes here, and Enter
    // silently killing a response in progress is not what typing a follow-up means.
    // Escape and the send button's stop state are the ways to abort.
    if (!state || activeGenerationController || uploadingAttachments) return;
    const composer = $('#cc-editor-composer');
    const text = composer.value.trim();
    const attachments = normalizeImageAttachments(state.draftAttachments);
    if (composer.disabled) return;
    const hasDraft = Boolean(text || attachments.length);
    const conversation = hasDraft ? ensureConversation() : activeConversation();
    // An empty submit after a stalled user turn should retry that turn without
    // adding a duplicate user bubble. Empty submits in every other state remain
    // no-ops.
    if (!conversation || (!hasDraft && conversation.messages.at(-1)?.role !== 'user' && !conversation.pendingContinuation)) return;
    abortedByUser = false;
    record();
    appendPendingCardChangeNotice(conversation);
    delete conversation.pendingContinuation;
    if (hasDraft) conversation.messages.push({ id: uuidv4(), role: 'user', text, attachments });
    state.draft = '';
    state.draftAttachments = [];
    composer.value = '';
    composer.scrollTop = 0;
    autoSize(composer);
    renderChat();
    persist();
    await generateAssistant(conversation);
}
function rerollLastAssistant() {
    if (!state || activeGenerationController) return false;
    const conversation = activeConversation();
    if (!conversation) return false;
    let assistantIndex = -1;
    for (let index = conversation.messages.length - 1; index >= 0; index--) {
        if (!['assistant', 'user'].includes(conversation.messages[index].role)) continue;
        if (conversation.messages[index].role !== 'assistant' || conversation.messages[index].streaming) return false;
        assistantIndex = index;
        break;
    }
    if (assistantIndex < 0 || !conversation.messages.slice(0, assistantIndex).some(message => message.role === 'user')) return false;
    record();
    conversation.messages.splice(assistantIndex, 1);
    abortedByUser = false;
    persist();
    void generateAssistant(conversation);
    return true;
}
function newConversation() {
    const blank = state.conversations.find(conversation => conversation.messages.length === 0);
    if (blank) {
        state.activeConversation = blank.id;
        initializeConversationCardState(blank);
        render();
        persist();
        return;
    }
    record();
    const conversation = initializeConversationCardState({ id: uuidv4(), created: Date.now(), messages: [] });
    state.conversations.unshift(conversation);
    state.activeConversation = conversation.id;
    render();
    persist();
}
function forkConversationAtMessage(messageId) {
    if (!state || activeGenerationController) return false;
    const source = activeConversation();
    const messageIndex = source?.messages.findIndex(message => message.id === messageId) ?? -1;
    if (messageIndex < 0 || source.messages[messageIndex].role !== 'user') return false;
    record();
    const conversation = deepCopy({
        ...source,
        id: uuidv4(),
        created: Date.now(),
        messages: source.messages.slice(0, messageIndex + 1),
    });
    delete conversation.pendingContinuation;
    delete conversation.pendingCardState;
    state.conversations.unshift(conversation);
    state.activeConversation = conversation.id;
    render();
    persist();
    return true;
}
async function restoreCheckpoint(id, label) {
    const item = state.checkpoints.find(entry => entry.id === id);
    if (!item?.state) return false;
    // Older checkpoints stored the whole workspace. Take only the card keys, so restoring
    // a backup never rewinds the editor conversation along with the card.
    const card = Object.fromEntries(Object.entries(cardSnapshot(item.state)).filter(([, value]) => value !== undefined));
    if (!Object.keys(card).length) return false;
    const confirmed = await Popup.show.confirm('Restore this backup?', `Every card field goes back to how it was before "${label}". This can be undone with Ctrl+Z.`);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return false;
    record();
    restoreSnapshot(card);
    toastr.success('Card restored from backup.', 'Character card editor');
    return true;
}
function showHistory() {
    const content = document.createElement('div'); content.className = 'cc-editor-history-popup';
    const backups = state.checkpoints.map(item => {
        const legacyPending = Object.values(item.state?.pending || {});
        const legacyHunks = legacyPending.flatMap(pending => pendingDiffParts(pending).filter(part => part.type === 'hunk').map(part => ({ field: pending.field, content: changeContent(part.removed, part.added) })));
        const legacyContent = legacyHunks.map(part => legacyHunks.every(other => other.field === part.field) ? part.content : `${fieldLabel(part.field)}\n${part.content}`).join('\n\n');
        const savedContent = item.content || legacyContent || Object.entries(item.state?.values || {}).map(([id, value]) => `${fieldLabel(id)}:\n${asText(value)}`).join('\n\n');
        let label = String(item.label || 'Card snapshot').replace(/^Before\s+/i, '');
        if (/^(accepting|rejecting) AI edit/i.test(label) && legacyPending[0]) label = `${fieldLabel(legacyPending[0].field)} AI proposal`;
        return `<section class="cc-editor-backup-entry"><div class="cc-backup-entry-header"><strong>${escapeHtml(label)}</strong><button class="cc-backup-restore menu_button menu_button_icon" data-checkpoint="${escapeHtml(item.id)}" data-label="${escapeHtml(label)}" type="button" title="Restore the card to this point"><i class="fa-solid fa-clock-rotate-left"></i><span>Restore</span></button></div>${savedContent ? `<pre>${backupContentHtml(savedContent)}</pre>` : ''}</section>`;
    }).join('') || '<div class="cc-editor-history-empty">No backups yet.</div>';
    const entries = state.conversations.map(conversation => {
        const firstMessage = conversation.messages.find(message => message.role === 'user');
        const first = firstMessage?.text || (firstMessage?.attachments?.length ? `${firstMessage.attachments.length} image attachment${firstMessage.attachments.length === 1 ? '' : 's'}` : 'Empty conversation');
        const detail = `${conversation.messages.length} message${conversation.messages.length === 1 ? '' : 's'}`;
        return `<button class="cc-editor-history-entry" data-conversation="${conversation.id}" aria-current="${conversation.id === state.activeConversation}" type="button"><strong>${escapeHtml(first)}</strong><small>${escapeHtml(detail)}</small></button>`;
    }).join('') || '<div class="cc-editor-history-empty">No editor conversations yet.</div>';
    content.innerHTML = `<h4>Backups</h4>${backups}<h4>Conversations</h4>${entries}`;
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { wider: true, animation: 'fast' });
    content.querySelectorAll('[data-conversation]').forEach(button => button.addEventListener('click', async () => {
        state.activeConversation = button.dataset.conversation;
        appendPendingCardChangeNotice(activeConversation());
        renderChat();
        persist();
        await popup.complete(POPUP_RESULT.CANCELLED);
    }));
    content.querySelectorAll('[data-checkpoint]').forEach(button => button.addEventListener('click', async () => {
        // The confirmation is its own popup, so this one only closes once the restore
        // actually happened. Backing out leaves the history list where it was.
        if (await restoreCheckpoint(button.dataset.checkpoint, button.dataset.label)) await popup.complete(POPUP_RESULT.CANCELLED);
    }));
    void popup.show();
}
function setupDivider() {
    const divider = $('#cc-editor-divider');
    divider.addEventListener('pointerdown', event => { if (!state) return; resizeStart = { x: event.clientX, width: state.cardWidth }; divider.setPointerCapture(event.pointerId); });
    divider.addEventListener('pointermove', event => { if (!resizeStart) return; const area = $('.cc-editor-workspace'); state.cardWidth = Math.min(78, Math.max(45, resizeStart.width + ((event.clientX - resizeStart.x) / area.clientWidth * 100))); $('#character-card-editor').style.setProperty('--cc-card-width', `${state.cardWidth}%`); positionPendingControls(); });
    divider.addEventListener('pointerup', () => {
        resizeStart = null;
        $('#cc-editor-card')?.querySelectorAll('.cc-pending-field').forEach(input => scheduleLineNumberUpdate(input));
        persist();
    });
}
// Text controls keep their own native undo stack. A card-wide undo triggered from inside
// one would rebuild the whole card and drop the caret mid-word.
function isEditorTextControl(target) {
    const element = target instanceof Element ? target : null;
    if (!element?.closest('#character-card-editor')) return false;
    return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable;
}
function setupKeyboard() {
    document.addEventListener('keydown', event => {
        if (!$('#character-card-editor').classList.contains('openDrawer')) return;
        if (event.key === 'Escape' && activeGenerationController) {
            event.preventDefault();
            event.stopPropagation();
            stopGeneration();
            return;
        }
        if (!state || !event.ctrlKey || isEditorTextControl(event.target)) return;
        // Undo restores whole conversations, so mid-response it would orphan the message
        // being streamed into: the reply would keep arriving somewhere nothing renders.
        if (activeGenerationController) return;
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); const next = event.shiftKey ? redo.pop() : undo.pop(); if (next) { pushHistory(event.shiftKey ? undo : redo, snapshot()); restoreSnapshot(next); } }
        if (event.key.toLowerCase() === 'y') { event.preventDefault(); const next = redo.pop(); if (next) { pushHistory(undo, snapshot()); restoreSnapshot(next); } }
    });
}
export async function initCharacterCardEditor() {
    try {
        characterDesignerPromptResource = await loadCharacterDesignerPrompts();
        registerCharacterDesignerTools();
    } catch (error) {
        console.error('Character Designer prompt resource could not be loaded.', error);
        toastr.error('The Character Designer prompt document could not be loaded. The editor is unavailable until the page is refreshed.', 'Character card editor');
        return;
    }
    syncEditorViewportBounds();
    const navigation = $('#top-settings-holder');
    if (navigation && !editorLayoutObserver) {
        editorLayoutObserver = new ResizeObserver(syncEditorViewportBounds);
        editorLayoutObserver.observe(navigation);
    }
    $('#character-card-editor-button .drawer-toggle')?.addEventListener('click', async () => {
        const editor = $('#character-card-editor');
        syncEditorViewportBounds();
        // The shared drawer handler runs after this listener. Do no work while
        // closing. On opening, build and measure the editor while it is hidden,
        // then reveal the already-complete layout once the shared handler opens it.
        if (editor.classList.contains('openDrawer')) {
            workspaceLoadToken++;
            rememberCardSectionScroll();
            persistWorkspace();
            removeFloatingHunkControls();
            return;
        }
        // The shared handler opens the drawer either way, so leaving a stale card on
        // screen would invite edits that quietly go nowhere.
        if (!currentCharacter()) { state = null; workspaceAvatarUrl = null; removeFloatingHunkControls(); renderNoCharacter(); return; }
        const loadToken = ++workspaceLoadToken;
        const avatarUrl = currentCharacter().avatar;
        editor.classList.add('cc-editor-preparing');
        let savedWorkspace = null;
        try {
            savedWorkspace = await loadStoredWorkspace();
        } catch (error) {
            console.error('Character card editor: could not load the workspace.', error);
            toastr.error('The Character Designer workspace file could not be loaded. Starting with a fresh workspace.', 'Character card editor');
        }
        if (loadToken !== workspaceLoadToken || currentCharacter()?.avatar !== avatarUrl || !editor.classList.contains('openDrawer')) {
            editor.classList.remove('cc-editor-preparing');
            return;
        }
        workspaceAvatarUrl = avatarUrl;
        state = createState(savedWorkspace); undo = []; redo = []; focusedEdit = null; snappedEditKey = null; customInstructionsFocusSnapshot = null;
        if (state.lorebookProposal && JSON.stringify(state.lorebook) !== JSON.stringify(liveCharacterBook())) {
            writeLorebookToCard();
        }
        appendPendingCardChangeNotice(activeConversation());
        persist();
        render();
        const revealWhenOpen = () => {
            if (!editor.classList.contains('openDrawer')) {
                openRenderFrame = requestAnimationFrame(revealWhenOpen);
                return;
            }
            // autoSize's frame was queued by render(), so this second frame runs
            // only after every textarea has its final height.
            openRenderFrame = requestAnimationFrame(() => {
                editor.classList.remove('cc-editor-preparing');
                positionPendingControls();
                openRenderFrame = 0;
            });
        };
        cancelAnimationFrame(openRenderFrame);
        openRenderFrame = requestAnimationFrame(revealWhenOpen);
    }, { capture: true });
    $('#cc-editor-card')?.addEventListener('scroll', () => {
        if (!state) return;
        rememberCardSectionScroll();
        persist();
    }, { passive: true });
    // Unlike Enter, the button visibly turns into a stop control while generating.
    $('#cc-editor-send')?.addEventListener('click', () => { if (activeGenerationController) stopGeneration(); else void send(); });
    $('#cc-editor-attach')?.addEventListener('click', () => openAttachmentPicker());
    $('#cc-editor-image-input')?.addEventListener('change', event => {
        const targetMessageId = attachmentTargetMessageId;
        attachmentTargetMessageId = null;
        void uploadImageAttachments(event.target.files, targetMessageId);
    });
    $('#cc-editor-composer')?.addEventListener('input', event => { if (!state) return; state.draft = event.target.value; autoSize(event.target); persist(); });
    $('#cc-editor-composer')?.addEventListener('paste', event => {
        const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
        if (!files.length) return;
        event.preventDefault();
        void uploadImageAttachments(files);
    });
    $('#cc-editor-composer')?.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' && !event.currentTarget.value && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && rerollLastAssistant()) {
            event.preventDefault();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    });
    $('#cc-editor-custom-instructions-button')?.addEventListener('click', () => { if (state) void toggleCustomInstructionsPopup(); });
    $('#cc-editor-questioning-mode')?.addEventListener('change', event => {
        const mode = event.target.value;
        accountStorage.setItem(CHARACTER_DESIGNER_MODE_KEY, ['Adaptive', 'Interview', 'Autonomous'].includes(mode) ? mode : 'Adaptive');
    });
    $('#cc-editor-new-chat')?.addEventListener('click', () => { if (state) newConversation(); });
    $('#cc-editor-reject-all')?.addEventListener('click', () => { if (state) resolveAllPending('reject'); });
    $('#cc-editor-accept-all')?.addEventListener('click', () => { if (state) resolveAllPending('accept'); });
    $('#cc-editor-previous-edit')?.addEventListener('click', () => { if (state) snapToPendingEdit(-1); });
    $('#cc-editor-next-edit')?.addEventListener('click', () => { if (state) snapToPendingEdit(1); });
    $('#cc-editor-previous-message')?.addEventListener('click', () => scrollToConversationMessage(-1));
    $('#cc-editor-next-message')?.addEventListener('click', () => scrollToConversationMessage(1));
    $('#cc-editor-messages')?.addEventListener('scroll', updateMessageNavigationButtons, { passive: true });
    $('#cc-editor-history')?.addEventListener('click', () => { if (state) showHistory(); });
    const editorChat = $('#cc-editor-chat');
    let imageDragDepth = 0;
    editorChat?.addEventListener('dragenter', event => {
        if (!Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file')) return;
        event.preventDefault();
        imageDragDepth++;
        editorChat.classList.add('cc-image-dragover');
    });
    editorChat?.addEventListener('dragover', event => {
        if (!Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    editorChat?.addEventListener('dragleave', () => {
        imageDragDepth = Math.max(0, imageDragDepth - 1);
        if (!imageDragDepth) editorChat.classList.remove('cc-image-dragover');
    });
    editorChat?.addEventListener('drop', event => {
        event.preventDefault();
        imageDragDepth = 0;
        editorChat.classList.remove('cc-image-dragover');
        const targetMessage = event.target?.closest?.('.cc-user-message');
        void uploadImageAttachments(Array.from(event.dataTransfer?.files || []), targetMessage?.dataset.messageId || null);
    });
    document.querySelectorAll('.cc-editor-mobile-tabs button').forEach(button => button.addEventListener('click', () => { $('#character-card-editor').dataset.mobilePane = button.dataset.pane; document.querySelectorAll('.cc-editor-mobile-tabs button').forEach(item => item.classList.toggle('selected', item === button)); requestAnimationFrame(positionPendingControls); }));
    const card = $('#cc-editor-card');
    // Scroll events do not bubble. Capture them so the floating controls also
    // follow a hunk while its capped field is the element being scrolled.
    card?.addEventListener('scroll', positionPendingControls, { passive: true, capture: true });
    card?.addEventListener('pointermove', event => { cardPointer = { x: event.clientX, y: event.clientY }; }, { passive: true });
    card?.addEventListener('pointerover', event => {
        const hunk = event.target?.closest?.('.cc-pending-hunk');
        // Hovering hands control back to the pointer: the controls now live as long
        // as the pointer stays near them.
        if (hunk) { pinnedHunk = false; showHunkControls(hunk); } else scheduleHunkControlsHide();
    });
    card?.addEventListener('pointerleave', () => { cardPointer = null; scheduleHunkControlsHide(); });
    // Focus covers keyboard users and taps that land on a hunk's editable text.
    card?.addEventListener('focusin', event => {
        const hunk = event.target?.closest?.('.cc-pending-hunk');
        if (hunk) showHunkControls(hunk);
    });
    // A tap leaves no hover behind, so tapping a hunk keeps its controls up until
    // something else is tapped. On touch this is the only thing that reveals them.
    document.addEventListener('click', event => {
        if (event.target?.closest?.('.cc-floating-hunk-controls')) return;
        const hunk = event.target?.closest?.('.cc-pending-hunk');
        if (hunk) { pinnedHunk = true; showHunkControls(hunk); hunkControlsElement(); positionPendingControls(); }
        else if (pinnedHunk) hideHunkControls();
    });
    window.addEventListener('resize', () => {
        syncEditorViewportBounds();
        updateMessageNavigationButtons();
        $('#cc-editor-card')?.querySelectorAll('.cc-pending-field').forEach(input => scheduleLineNumberUpdate(input));
        positionPendingControls();
    });
    // The editor closes through any drawer the app opens, not only its own toggle,
    // and its controls live on document.body where a stale one would float over
    // whatever replaces it.
    const editorPanel = $('#character-card-editor');
    if (editorPanel) {
        new MutationObserver(() => {
            if (!editorPanel.classList.contains('openDrawer')) {
                if (state) {
                    cancelDebounce(persist);
                    rememberCardSectionScroll();
                    persistWorkspace();
                }
                removeFloatingHunkControls();
                void closeCustomInstructionsPopup();
            }
        })
            .observe(editorPanel, { attributes: true, attributeFilter: ['class'] });
    }
    setupDivider(); setupKeyboard();
    // OpenAI settings populate asynchronously. The checkbox is a view of this
    // setting, so update an already-open editor after the source of truth loads.
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, () => {
        removeLegacyWorkspaceSettings();
        if (state && $('#character-card-editor').classList.contains('openDrawer')) renderChat();
    });
    eventSource.on(event_types.CHARACTER_EDITED, () => {
        if (!state || !$('#character-card-editor').classList.contains('openDrawer') || workspaceMatchesCard()) return;
        if (activeGenerationController) {
            pendingExternalCardRefresh = true;
            return;
        }
        void refreshExternalCardState();
    });
}

async function refreshExternalCardState() {
    if (!state) return;
    // Canonical state equality acknowledges editor-owned saves. Persist the live
    // transcript first so rebuilding card state cannot roll back recent messages.
    await persistWorkspace();
    try {
        state = createState(await loadStoredWorkspace());
    } catch (error) {
        console.error('Character card editor: could not refresh the workspace.', error);
        toastr.error('The Character Designer workspace file could not be refreshed.', 'Character card editor');
        return;
    }
    focusedEdit = null;
    customInstructionsFocusSnapshot = null;
    appendPendingCardChangeNotice(activeConversation());
    render();
    persist();
}
