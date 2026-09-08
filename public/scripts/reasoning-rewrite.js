import {
    characters,
    chat,
    event_types,
    eventSource,
    messageFormatting,
    saveChatDebounced,
    saveSettingsDebounced,
    streamingProcessor,
    substituteParams,
    this_chid,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { IGNORE_SYMBOL } from './constants.js';
import { t } from './i18n.js';
import { DEFAULT_REASONING_REWRITE_PROMPT, power_user } from './power-user.js';
import { ReasoningState } from './reasoning.js';
import { applyStreamFadeIn } from './util/stream-fadein.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { ChatCompletionService } from './custom-request.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { waitUntilCondition } from './utils.js';
import { setWorkspaceChatSnapshot } from './chat-workspace-cache.js';

/**
 * @typedef {object} ReasoningRewritePreset
 * @property {string} name - The name of the preset
 * @property {string} prompt - The rewrite prompt text
 */

/**
 * @type {ReasoningRewritePreset[]} List of reasoning rewrite presets
 */
export const reasoning_rewrite_presets = [];

/**
 * @typedef {object} ReasoningRewriteGoalPreset
 * @property {string} name - The name of the preset
 * @property {string} goal - The rewrite goal text
 */

/**
 * @type {ReasoningRewriteGoalPreset[]} List of reasoning rewrite goal presets
 */
export const reasoning_rewrite_goal_presets = [];

/**
 * Active rewrite sessions keyed by compound `${chatKey}::${messageId}::${swipeId}`
 * @type {Map<string, RewriteSession>}
 */
const activeSessions = new Map();

/**
 * Returns a stable identifier key for the currently active chat/tab.
 * Works across single-character chats, group chats, and workspace tabs.
 *
 * @returns {string}
 */
export function getCurrentChatKey() {
    if (selected_group) {
        return `group:${selected_group}`;
    }
    if (this_chid !== undefined && characters?.[this_chid]) {
        const char = characters[this_chid];
        return `character:${char.avatar || this_chid}:${char.chat || 'default'}`;
    }
    return 'default';
}

/**
 * Represents an in-flight rewrite session bound to a specific chat, message, and swipe.
 */
export class RewriteSession {
    /**
     * @param {string} chatKey - Stable identifier for the originating chat
     * @param {Array<any>} targetChat - Reference to the chat array at generation start
     * @param {object} targetMessage - Reference to the message object at generation start
     * @param {number} messageId - Message index in targetChat
     * @param {number} swipeId - Swipe index
     * @param {string} rawReasoning - Completed raw reasoning text
     * @param {object|null} chatIdentity - Workspace chat identity object
     * @param {object|null} processor - StreamingProcessor reference for this generation
     */
    constructor(chatKey, targetChat, targetMessage, messageId, swipeId, rawReasoning, chatIdentity = null, processor = null) {
        this.chatKey = chatKey;
        this.targetChat = targetChat;
        this.targetMessage = targetMessage;
        this.messageId = messageId;
        this.swipeId = swipeId;
        this.rawReasoning = rawReasoning;
        this.chatIdentity = chatIdentity;
        this.processor = processor;
        this.rewriteText = '';
        /** @type {'waiting' | 'streaming' | 'completed' | 'failed' | 'aborted'} */
        this.state = 'waiting';
        this.abortController = new AbortController();
    }
}

/**
 * Retrieves the last N non-system messages preceding the given messageId from sourceChat.
 * Preserves original roles ('user' or 'assistant').
 *
 * @param {number} currentMessageId
 * @param {number} depth
 * @param {Array<any>} sourceChat
 * @returns {{ role: string, content: string }[]}
 */
export function getContextMessages(currentMessageId, depth = 2, sourceChat = chat) {
    const rawDepth = Number(depth);
    const clampedDepth = Number.isFinite(rawDepth) ? Math.max(0, Math.min(20, rawDepth)) : 2;
    if (clampedDepth === 0 || !Array.isArray(sourceChat)) return [];

    const messages = [];
    for (let i = currentMessageId - 1; i >= 0 && messages.length < clampedDepth; i--) {
        const item = sourceChat[i];
        if (!item) continue;
        if (item.is_system || item.extra?.isSmallSys || item.extra?.[IGNORE_SYMBOL]) {
            continue;
        }
        if (!item.mes || typeof item.mes !== 'string') {
            continue;
        }
        messages.unshift({
            role: item.is_user ? 'user' : 'assistant',
            content: item.mes,
        });
    }
    return messages;
}

/**
 * Constructs the chat completion messages payload for the rewrite request.
 *
 * @param {{ role: string, content: string }[]} contextMessages
 * @param {string} rawReasoning
 * @returns {{ role: string, content: string }[]}
 */
export function buildRewriteMessages(contextMessages, rawReasoning) {
    const goal = (power_user.reasoning_rewrite?.goal ?? '').trim();
    let systemPrompt = (power_user.reasoning_rewrite?.prompt ?? '').trim() || DEFAULT_REASONING_REWRITE_PROMPT;
    if (goal) {
        systemPrompt += `\n\nRewrite Goal:\n${goal}`;
    }
    systemPrompt = substituteParams(systemPrompt);

    return [
        { role: 'system', content: systemPrompt },
        ...contextMessages,
        { role: 'user', content: `Here is the reasoning to rewrite:\n\n${rawReasoning}` },
    ];
}

/**
 * Applies a rewrite status to the status element. The label text is rendered in
 * JS (rather than CSS content) so it goes through i18n.
 *
 * @param {HTMLElement|null} statusDom
 * @param {'waiting' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'idle'} status
 */
function setRewriteStatus(statusDom, status) {
    if (!statusDom) return;
    statusDom.dataset.status = status;
    statusDom.textContent = {
        waiting: t`Waiting for reasoning…`,
        streaming: t`Rewriting…`,
        failed: t`⚠ Rewrite failed`,
        aborted: t`Rewrite aborted`,
    }[status] ?? '';
}

/**
 * Runs the secondary rewrite generation request for an active session.
 *
 * @param {RewriteSession} session
 * @returns {Promise<void>}
 */
export async function runRewriteSession(session) {
    session.state = 'streaming';

    /**
     * Resolves DOM elements only when the currently rendered chat matches the session's chat.
     */
    const getTargetDoms = () => {
        if (session.chatKey !== getCurrentChatKey()) {
            return { messageDom: null, contentDom: null, statusDom: null };
        }
        const messageDom = document.querySelector(`#chat .mes[mesid="${session.messageId}"]`);
        if (!messageDom) return { messageDom: null, contentDom: null, statusDom: null };
        messageDom.dataset.rewriteActive = 'true';
        const contentDom = messageDom.querySelector('.mes_reasoning_rewrite_content');
        const statusDom = messageDom.querySelector('.mes_reasoning_rewrite_status');
        return { messageDom, contentDom, statusDom };
    };

    const { statusDom } = getTargetDoms();
    setRewriteStatus(statusDom, 'streaming');

    try {
        const rawDepth = Number(power_user.reasoning_rewrite?.context_depth);
        const contextDepth = Number.isFinite(rawDepth) ? Math.max(0, Math.min(20, rawDepth)) : 2;
        // Always extract context messages from the originating session.targetChat
        const contextMessages = getContextMessages(session.messageId, contextDepth, session.targetChat);
        const messages = buildRewriteMessages(contextMessages, session.rawReasoning);

        const profileId = (power_user.reasoning_rewrite?.profile_id ?? '').trim();
        const rawMax = Number(power_user.reasoning_rewrite?.max_tokens);
        const maxTokens = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 4096;
        const rawTemp = Number(power_user.reasoning_rewrite?.temperature);
        const temperature = Number.isFinite(rawTemp) ? Math.max(0, Math.min(2, rawTemp)) : 0.7;

        let streamResponse = null;

        // If user explicitly selected a profile, use it. Do NOT fall back to active chat connection if it fails.
        if (profileId) {
            streamResponse = await ConnectionManagerRequestService.sendRequest(
                profileId,
                messages,
                maxTokens,
                {
                    stream: true,
                    signal: session.abortController.signal,
                    extractData: true,
                    includePreset: true,
                },
                { temperature },
            );
        } else {
            // Only use active connection when no rewrite profile was selected
            streamResponse = await ChatCompletionService.processRequest(
                {
                    stream: true,
                    messages,
                    max_tokens: maxTokens,
                    model: getChatCompletionModel(oai_settings),
                    chat_completion_source: oai_settings.chat_completion_source,
                    temperature,
                },
                {},
                true,
                session.abortController.signal,
            );
        }

        if (session.abortController.signal.aborted) {
            session.state = 'aborted';
            setRewriteStatus(getTargetDoms().statusDom, 'aborted');
            return;
        }

        // Both ConnectionManagerRequestService (Chat & Text completion) and ChatCompletionService
        // stream generators yield chunk.text as cumulative text.
        if (typeof streamResponse === 'function') {
            const generator = streamResponse();
            for await (const chunk of generator) {
                if (session.abortController.signal.aborted) {
                    session.state = 'aborted';
                    break;
                }
                session.rewriteText = chunk.text;
                const { contentDom } = getTargetDoms();
                if (contentDom) {
                    const formatted = messageFormatting(session.rewriteText, '', false, false, session.messageId, {}, true);
                    if (power_user.stream_fade_in) {
                        applyStreamFadeIn(contentDom, formatted);
                    } else {
                        contentDom.innerHTML = formatted;
                    }
                }
            }
        } else if (streamResponse && typeof streamResponse === 'object') {
            session.rewriteText = streamResponse.content || '';
        }

        if (session.abortController.signal.aborted) {
            session.state = 'aborted';
            setRewriteStatus(getTargetDoms().statusDom, 'aborted');
            return;
        }

        // Finalize completed rewrite
        session.state = 'completed';
        const { contentDom: finalContent, statusDom: finalStatus } = getTargetDoms();
        setRewriteStatus(finalStatus, 'completed');
        if (finalContent && session.rewriteText) {
            finalContent.innerHTML = messageFormatting(session.rewriteText, '', false, false, session.messageId, {}, true);
        }

        // Persist directly into originating message object in memory
        const target = session.targetMessage;
        if (target) {
            target.extra ??= {};
            target.extra.reasoning_rewrite = session.rewriteText;
            target.extra.reasoning_rewrite_meta = {
                profile_id: profileId,
                context_depth: contextDepth,
                goal: power_user.reasoning_rewrite?.goal || '',
            };

            // Also persist into swipe_info for the specific originating swipe
            if (target.swipe_info?.[session.swipeId]) {
                target.swipe_info[session.swipeId].extra ??= {};
                target.swipe_info[session.swipeId].extra.reasoning_rewrite = session.rewriteText;
                target.swipe_info[session.swipeId].extra.reasoning_rewrite_meta = structuredClone(target.extra.reasoning_rewrite_meta);
            }

            // Update workspace tab cached snapshot if originating chat has workspace identity
            if (session.chatIdentity) {
                try {
                    setWorkspaceChatSnapshot(session.chatIdentity, null, session.targetChat);
                } catch (snapErr) {
                    console.debug('[Reasoning Rewrite] Failed to update workspace snapshot:', snapErr);
                }
            }

            // If user is currently on the originating chat, trigger normal debounced chat save
            if (session.targetChat === chat) {
                saveChatDebounced();
            }
        }
    } catch (err) {
        if (session.abortController.signal.aborted) {
            session.state = 'aborted';
            setRewriteStatus(getTargetDoms().statusDom, 'aborted');
            return;
        }

        console.error('[Reasoning Rewrite] Rewrite request failed:', err);
        session.state = 'failed';
        setRewriteStatus(getTargetDoms().statusDom, 'failed');
    } finally {
        // Prune terminal session after cooldown so memory is not held indefinitely
        setTimeout(() => {
            const key = `${session.chatKey}::${session.messageId}::${session.swipeId}`;
            if (activeSessions.get(key) === session && session.state !== 'streaming' && session.state !== 'waiting') {
                activeSessions.delete(key);
            }
        }, 10000);
    }
}

/**
 * Updates the reasoning rewrite DOM elements for a given message.
 * Called by ReasoningHandler.updateDom().
 *
 * @param {number} messageId
 * @param {HTMLElement} messageDom
 */
export function updateReasoningRewriteDom(messageId, messageDom) {
    if (!messageDom || isNaN(messageId)) return;
    const message = chat[messageId];
    if (!message) return;

    const rewritePane = messageDom.querySelector('.mes_reasoning_rewrite');
    const rewriteContent = messageDom.querySelector('.mes_reasoning_rewrite_content');
    const rewriteStatus = messageDom.querySelector('.mes_reasoning_rewrite_status');
    if (!rewritePane || !rewriteContent || !rewriteStatus) return;

    const chatKey = getCurrentChatKey();
    const swipeId = message.swipe_id ?? 0;
    const sessionKey = `${chatKey}::${messageId}::${swipeId}`;
    const session = activeSessions.get(sessionKey);

    // 1. In-flight active rewrite session for this chat and message+swipe
    if (session && (session.state === 'waiting' || session.state === 'streaming')) {
        messageDom.dataset.rewriteActive = 'true';
        setRewriteStatus(rewriteStatus, session.state);
        if (session.rewriteText) {
            const formatted = messageFormatting(session.rewriteText, '', false, false, messageId, {}, true);
            if (power_user.stream_fade_in) {
                applyStreamFadeIn(rewriteContent, formatted);
            } else {
                rewriteContent.innerHTML = formatted;
            }
        } else {
            rewriteContent.innerHTML = '';
        }
        return;
    }

    // 2. Saved completed rewrite from message extra
    const savedRewrite = message.extra?.reasoning_rewrite;
    if (savedRewrite && savedRewrite.trim()) {
        messageDom.dataset.rewriteActive = 'true';
        setRewriteStatus(rewriteStatus, 'completed');
        rewriteContent.innerHTML = messageFormatting(savedRewrite, '', false, false, messageId, {}, true);
        return;
    }

    // 3. Failed or aborted session for this chat and message+swipe
    if (session && (session.state === 'failed' || session.state === 'aborted')) {
        messageDom.dataset.rewriteActive = 'true';
        setRewriteStatus(rewriteStatus, session.state);
        return;
    }

    // 4. Original reasoning is actively thinking, waiting for reasoning to end
    const isThinking = messageDom.dataset.reasoningState === 'thinking';
    if (power_user.reasoning_rewrite?.enabled && isThinking) {
        messageDom.dataset.rewriteActive = 'true';
        setRewriteStatus(rewriteStatus, 'waiting');
        rewriteContent.innerHTML = '';
        return;
    }

    // 5. Inactive / disabled
    delete messageDom.dataset.rewriteActive;
    setRewriteStatus(rewriteStatus, 'idle');
    rewriteContent.innerHTML = '';
}

/**
 * Event handler triggered when reasoning completes on the primary generation.
 * Recovers originating chat and message references strictly from generationOrigin
 * captured at generation start.
 *
 * @param {string} reasoning - Completed reasoning text
 * @param {number|null} duration - Duration in ms
 * @param {number} messageId - Chat message array index
 * @param {string} state - Reasoning state (Done or Hidden)
 * @param {object|null} generationOrigin - Origin metadata bound at generation start
 */
async function onStreamReasoningDone(reasoning, duration, messageId, state, generationOrigin = null) {
    if (!power_user.reasoning_rewrite?.enabled) return;
    if (typeof reasoning !== 'string' || !reasoning.trim()) return;
    if (state === ReasoningState.Hidden) return;

    // Recover origin strictly from generation-bound state captured at primary generation start
    const chatKey = generationOrigin?.chatKey ?? getCurrentChatKey();
    const targetChat = generationOrigin?.targetChat ?? chat;
    let targetMessage = generationOrigin?.targetMessage ?? targetChat[messageId];
    const targetMessageId = generationOrigin?.messageId ?? messageId;
    const swipeId = generationOrigin?.swipeId ?? (targetMessage?.swipe_id ?? 0);
    const chatIdentity = generationOrigin?.chatIdentity ?? null;
    const processor = generationOrigin?.processor ?? streamingProcessor;

    if (!targetMessage) {
        // Fallback buffering check in case generationOrigin was omitted
        await waitUntilCondition(() => Boolean(targetChat[targetMessageId]), 2000, 50);
        targetMessage = targetChat[targetMessageId];
    }
    if (!targetMessage) {
        console.warn(`[Reasoning Rewrite] Target message was not found in chat, skipping rewrite.`);
        return;
    }

    const sessionKey = `${chatKey}::${targetMessageId}::${swipeId}`;

    // Ensure launched only once per generation/swipe. A different reasoning text for the
    // same message+swipe is a fresh run after a quick regenerate: abort any in-flight
    // rewrite of the stale reasoning and replace finished ones instead of skipping.
    const existing = activeSessions.get(sessionKey);
    if (existing && existing.rawReasoning === reasoning) {
        if (existing.state === 'streaming' || existing.state === 'completed') {
            return;
        }
    } else if (existing && (existing.state === 'waiting' || existing.state === 'streaming')) {
        existing.abortController.abort();
    }

    const session = new RewriteSession(
        chatKey,
        targetChat,
        targetMessage,
        targetMessageId,
        swipeId,
        reasoning,
        chatIdentity,
        processor,
    );
    activeSessions.set(sessionKey, session);

    // Bind processor abort signal if this generation's processor is active
    if (processor?.abortController?.signal) {
        const onProcAbort = () => {
            if (session.state === 'waiting' || session.state === 'streaming') {
                session.abortController.abort();
                session.state = 'aborted';
            }
        };
        processor.abortController.signal.addEventListener('abort', onProcAbort, { once: true });
    }

    // Launch rewrite asynchronously without blocking primary generation
    runRewriteSession(session).catch((err) => {
        console.error('[Reasoning Rewrite] Unexpected error in session:', err);
    });
}

/**
 * Event handler for generation stopped — aborts only the active rewrite belonging to the stopped generation.
 */
function onGenerationStopped() {
    const currentChatKey = getCurrentChatKey();
    const stoppedMessageId = streamingProcessor?.messageId ?? (chat.length - 1);

    for (const session of activeSessions.values()) {
        // Only abort the session belonging to the originating chat and stopped generation
        if (session.chatKey === currentChatKey && session.messageId === stoppedMessageId) {
            if (session.state === 'streaming' || session.state === 'waiting') {
                session.abortController.abort();
                session.state = 'aborted';
                const messageDom = document.querySelector(`#chat .mes[mesid="${session.messageId}"]`);
                if (messageDom) {
                    setRewriteStatus(messageDom.querySelector('.mes_reasoning_rewrite_status'), 'aborted');
                }
            }
        }
    }
}

/**
 * Refreshes all currently visible reasoning rewrite DOM elements in #chat.
 * Called when switching tabs / chats so all generated tokens immediately appear.
 */
export function refreshAllVisibleReasoningRewrites() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const messageId = Number(el.getAttribute('mesid'));
        if (!isNaN(messageId)) {
            updateReasoningRewriteDom(messageId, el);
        }
    });
}

/**
 * Event handler for chat changed — prunes terminal sessions and refreshes visible rewrites.
 */
function onChatChanged() {
    for (const [key, session] of activeSessions.entries()) {
        if (session.state === 'completed' || session.state === 'failed' || session.state === 'aborted') {
            activeSessions.delete(key);
        }
    }
    populateConnectionProfiles();
    // Refresh visible rewrites for the newly active chat
    setTimeout(refreshAllVisibleReasoningRewrites, 0);
}

/**
 * Populates the connection profile select dropdown.
 */
export function populateConnectionProfiles() {
    const $select = $('#reasoning_rewrite_profile');
    if (!$select.length) return;

    const currentVal = power_user.reasoning_rewrite?.profile_id || '';
    $select.empty();
    $('<option>').val('').text('— Default / Active Chat Completion —').appendTo($select);

    try {
        const profiles = SillyTavern.getContext()?.extensionSettings?.connectionManager?.profiles || [];
        for (const profile of profiles) {
            const label = `${profile.name} (${profile.api || 'cc'} - ${profile.model || 'default'})`;
            $('<option>').val(profile.id).text(label).appendTo($select);
        }
    } catch (e) {
        console.debug('[Reasoning Rewrite] Connection manager profiles query failed:', e);
    }

    $select.val(currentVal);
}

/**
 * Loads reasoning rewrite presets from settings payload.
 *
 * @param {object} data - Settings data
 * @param {ReasoningRewritePreset[]} [data.reasoningRewrite] - Preset list from backend
 * @param {ReasoningRewriteGoalPreset[]} [data.reasoningRewriteGoal] - Goal preset list from backend
 */
export async function loadReasoningRewritePresets(data) {
    if (data.reasoningRewrite !== undefined) {
        reasoning_rewrite_presets.splice(0, reasoning_rewrite_presets.length, ...data.reasoningRewrite);
    }
    if (data.reasoningRewriteGoal !== undefined) {
        reasoning_rewrite_goal_presets.splice(0, reasoning_rewrite_goal_presets.length, ...data.reasoningRewriteGoal);
    }

    const $select = $('#reasoning_rewrite_preset_select');
    $select.empty();

    for (const preset of reasoning_rewrite_presets) {
        $('<option>').val(preset.name).text(preset.name).appendTo($select);
    }

    // Default selection
    const selectedPreset = power_user.reasoning_rewrite?.prompt_preset || 'Default';
    $select.val(selectedPreset);

    const $goalSelect = $('#reasoning_rewrite_goal_preset_select');
    $goalSelect.empty();

    for (const preset of reasoning_rewrite_goal_presets) {
        $('<option>').val(preset.name).text(preset.name).appendTo($goalSelect);
    }

    const selectedGoalPreset = power_user.reasoning_rewrite?.goal_preset || 'Default';
    $goalSelect.val(selectedGoalPreset);
}

/**
 * Binds UI settings controls for Reasoning Rewrite.
 */
function bindSettingsUI() {
    const settings = power_user.reasoning_rewrite;
    if (!settings) return;

    $('#reasoning_rewrite_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_profile').val(settings.profile_id).on('change', function () {
        settings.profile_id = String($(this).val());
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_context_depth').val(settings.context_depth).on('input change', function () {
        const val = Number($(this).val());
        settings.context_depth = Number.isFinite(val) ? Math.max(0, Math.min(20, val)) : 2;
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_goal_preset_select').on('change', function () {
        const name = String($(this).val());
        const preset = reasoning_rewrite_goal_presets.find(p => p.name === name);
        if (!preset) return;
        settings.goal_preset = name;
        settings.goal = preset.goal ?? '';
        $('#reasoning_rewrite_goal').val(preset.goal ?? '');
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_goal').val(settings.goal).on('input', function () {
        settings.goal = String($(this).val());
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_preset_select').on('change', function () {
        const name = String($(this).val());
        const preset = reasoning_rewrite_presets.find(p => p.name === name);
        if (!preset) return;
        settings.prompt_preset = name;
        settings.prompt = preset.prompt;
        $('#reasoning_rewrite_prompt').val(preset.prompt);
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_prompt').val(settings.prompt).on('input', function () {
        settings.prompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_temperature').val(settings.temperature).on('input change', function () {
        const val = Number($(this).val());
        settings.temperature = Number.isFinite(val) ? Math.max(0, Math.min(2, val)) : 0.7;
        saveSettingsDebounced();
    });

    $('#reasoning_rewrite_max_tokens').val(settings.max_tokens).on('input change', function () {
        const val = Number($(this).val());
        settings.max_tokens = Number.isFinite(val) && val > 0 ? val : 4096;
        saveSettingsDebounced();
    });
}

/**
 * Initializes the Reasoning Rewrite module.
 */
export function initReasoningRewrite() {
    bindSettingsUI();
    populateConnectionProfiles();

    // Event listeners
    eventSource.on(event_types.STREAM_REASONING_DONE, onStreamReasoningDone);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_LOADED, () => setTimeout(refreshAllVisibleReasoningRewrites, 0));

    // Refresh connection profiles when connection manager profiles change
    eventSource.on('connection_profile_updated', populateConnectionProfiles);
    eventSource.on('connection_profile_created', populateConnectionProfiles);
    eventSource.on('connection_profile_deleted', populateConnectionProfiles);
    $(document).on('click', '#user-settings-button', populateConnectionProfiles);
}
