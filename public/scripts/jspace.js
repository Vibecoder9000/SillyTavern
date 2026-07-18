import { localforage } from '../lib.js';
import { chat, chat_metadata, doNavbarIconClick, event_types, eventSource, getCurrentChatId, saveMetadata } from '../script.js';
import { t } from './i18n.js';
import { debounce, escapeHtml, getStringHash } from './utils.js';

const recordStore = localforage.createInstance({ name: 'SillyTavern_JSpace' });

const JSPACE_BUTTON_ID = 'jspace_workspace_button';
const JSPACE_ROOT_ID = 'jspace_workspace';
const JSPACE_SELECTION_KEY = 'jspace_selection';
const JSPACE_ANALYST_PROFILE_KEY = 'jspace_analyst_profile';

let pendingCapture = null;
let pendingJSpaceResponse = null;
let workspaceInitialized = false;
let workspaceRoot = null;
let renderState = {
    open: false,
    messageId: null,
    swipeIds: [],
    activeTab: 'details',
    activeRegion: 'transcript',
    searchQuery: '',
    analystProfileId: '',
    analystError: '',
    analystPending: false,
};

function nowIso() {
    return new Date().toISOString();
}

function getMessage(messageId) {
    return Number.isInteger(messageId) ? chat[messageId] : null;
}

function clone(value) {
    return value ? structuredClone(value) : value;
}

function normalizeRoleLabel(role) {
    const normalized = String(role || '').trim().toUpperCase();
    if (!normalized) {
        return 'SOURCE';
    }

    const map = {
        SYSTEM: 'SYSTEM',
        USER: 'USER',
        ASSISTANT: 'ASSISTANT',
        TOOL: 'TOOL',
        CHARACTER: 'CHARACTER',
        TEMPLATE: 'TEMPLATE',
        AUTHOR: 'AUTHOR NOTE',
        AUTHOR_NOTE: 'AUTHOR NOTE',
        LOREBOOK: 'LOREBOOK',
    };

    return map[normalized] || normalized.replace(/_/g, ' ');
}

function normalizeSectionLabel(key) {
    const map = {
        charDescription: 'CHARACTER',
        charPersonality: 'CHARACTER',
        scenarioText: 'SCENARIO',
        worldInfoString: 'LOREBOOK',
        authorsNoteString: 'AUTHOR NOTE',
        allAnchors: 'TEMPLATE',
        instruction: 'SYSTEM',
        userPersona: 'USER PERSONA',
        examplesString: 'EXAMPLES',
        mesSendString: 'CHAT HISTORY',
        promptBias: 'BIAS',
        chatInjects: 'INJECTIONS',
        summarizeString: 'SUMMARY',
        smartContextString: 'SMART CONTEXT',
        chatVectorsString: 'CHAT VECTORS',
        dataBankVectorsString: 'DATA BANK',
        finalPrompt: 'FINAL PROMPT',
    };

    return map[key] || String(key || 'SOURCE').replace(/([A-Z])/g, ' $1').trim().toUpperCase();
}

function buildPromptSnapshot(promptData = {}) {
    const snapshot = {
        rawPrompt: clone(promptData.rawPrompt) ?? '',
        finalPrompt: String(promptData.finalPrompt ?? ''),
        sourceSections: [],
    };

    if (Array.isArray(promptData.rawPrompt)) {
        snapshot.sourceSections = promptData.rawPrompt.map((entry, index) => ({
            id: `raw-${index}`,
            label: normalizeRoleLabel(entry?.role),
            text: Array.isArray(entry?.content)
                ? entry.content.map(x => x?.text ?? '').join('\n')
                : String(entry?.content ?? ''),
        })).filter(section => section.text.trim().length > 0);
        return snapshot;
    }

    const orderedKeys = [
        'instruction',
        'charDescription',
        'charPersonality',
        'scenarioText',
        'worldInfoString',
        'authorsNoteString',
        'allAnchors',
        'examplesString',
        'mesSendString',
        'chatInjects',
        'promptBias',
        'smartContextString',
        'chatVectorsString',
        'dataBankVectorsString',
        'finalPrompt',
    ];

    snapshot.sourceSections = orderedKeys.map((key) => ({
        id: key,
        label: normalizeSectionLabel(key),
        text: String(promptData[key] ?? ''),
    })).filter(section => section.text.trim().length > 0);

    if (!snapshot.sourceSections.length && typeof snapshot.rawPrompt === 'string' && snapshot.rawPrompt.trim().length > 0) {
        snapshot.sourceSections.push({
            id: 'rawPrompt',
            label: 'PROMPT',
            text: snapshot.rawPrompt,
        });
    }

    return snapshot;
}

function getSwipeExtra(message, swipeId) {
    return clone(message?.swipe_info?.[swipeId]?.extra) ?? {};
}

function getSwipeGenerationId(message, swipeId) {
    return message?.swipe_info?.[swipeId]?.extra?.jspace_generation_id ?? null;
}

function setSwipeGenerationId(message, swipeId, generationId, status) {
    if (!message?.swipe_info?.[swipeId]) {
        return;
    }

    message.swipe_info[swipeId].extra = message.swipe_info[swipeId].extra ?? {};
    message.swipe_info[swipeId].extra.jspace_generation_id = generationId;
    message.swipe_info[swipeId].extra.jspace_status = status;
    message.swipe_info[swipeId].extra.jspace_ref = generationId;

    if (Number(message.swipe_id) === Number(swipeId)) {
        message.extra = message.extra ?? {};
        message.extra.jspace_generation_id = generationId;
        message.extra.jspace_status = status;
        message.extra.jspace_ref = generationId;
    }
}

function buildContextSignature(record) {
    const signatureBase = JSON.stringify({
        api: record.model?.api ?? '',
        model: record.model?.model ?? '',
        prompt: record.promptSnapshot?.finalPrompt || record.promptSnapshot?.rawPrompt || '',
    });
    return `ctx_${getStringHash(signatureBase)}`;
}

function buildCaptureSummary(record) {
    const promptSections = Array.isArray(record.promptSnapshot?.sourceSections) ? record.promptSnapshot.sourceSections.length : 0;
    const promptPositions = record.promptSnapshot?.finalPrompt
        ? String(record.promptSnapshot.finalPrompt).length
        : Array.isArray(record.promptSnapshot?.rawPrompt)
            ? record.promptSnapshot.rawPrompt.length
            : String(record.promptSnapshot?.rawPrompt ?? '').length;
    const completionPositions = String(record.output?.text ?? '').length;

    return {
        prompt_positions: promptPositions,
        completion_positions: completionPositions,
        layers: Number(record.capture?.jspace?.summary?.layers ?? 0) || 0,
        top_readouts: Number(record.capture?.jspace?.summary?.top_readouts ?? 0) || 0,
        logprobs: Boolean(record.capture?.logprobs?.available),
        source_sections: promptSections,
    };
}

function buildRecordStatus(record) {
    if (record.capture?.jspace?.available) {
        return 'ready';
    }

    if (!record.promptSnapshot?.sourceSections?.length && !record.promptSnapshot?.rawPrompt) {
        return 'missing_prompt';
    }

    return 'missing_jspace';
}

function buildGateMessage(record) {
    if (!record) {
        return t`J-space data was not captured for this swipe.`;
    }

    if (!record.promptSnapshot?.sourceSections?.length && !record.promptSnapshot?.rawPrompt) {
        return t`The stored capture is incomplete or unreadable.`;
    }

    if (!record.capture?.jspace?.available) {
        return t`This connection does not provide the required J-space capability.`;
    }

    if (!record.capture?.logprobs?.available) {
        return t`Token logprobs are missing from one or more selected swipes.`;
    }

    return '';
}

function getRecordsGateMessage(records) {
    return records.map(buildGateMessage).find(Boolean) || '';
}

function getAnalystProfileId() {
    return renderState.analystProfileId || String(chat_metadata?.[JSPACE_ANALYST_PROFILE_KEY] ?? '');
}

async function persistAnalystProfile(profileId) {
    renderState.analystProfileId = profileId || '';
    chat_metadata[JSPACE_ANALYST_PROFILE_KEY] = profileId || '';
    await saveMetadata();
}

async function getAnalystProfiles() {
    const { extension_settings } = await import('./extensions.js');
    const manager = extension_settings.connectionManager;
    const isDisabled = extension_settings.disabledExtensions?.includes('connection-manager');

    return {
        available: Boolean(manager) && !isDisabled,
        profiles: Array.isArray(manager?.profiles) ? manager.profiles : [],
        selectedProfile: String(manager?.selectedProfile ?? ''),
    };
}

function mergeJSpaceArrays(existing, incoming, key) {
    const result = Array.isArray(existing) ? [...existing] : [];
    for (const item of Array.isArray(incoming) ? incoming : []) {
        const itemKey = item?.[key];
        const index = result.findIndex((value) => itemKey !== undefined && value?.[key] === itemKey);
        if (index === -1) {
            result.push(clone(item));
        } else {
            result[index] = { ...result[index], ...clone(item) };
        }
    }
    return result;
}

export function mergeJSpaceCaptures(existing, incoming) {
    if (!incoming || typeof incoming !== 'object') {
        return existing ?? null;
    }

    const merged = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        ...clone(incoming),
        vocab: { ...(existing?.vocab ?? {}), ...(incoming.vocab ?? {}) },
        prompt: mergeJSpaceArrays(existing?.prompt, incoming.prompt, 'position'),
        completion: mergeJSpaceArrays(existing?.completion, incoming.completion, 'sample_step'),
    };
    merged.available = true;
    const prompt = merged.prompt ?? [];
    const completion = merged.completion ?? [];
    merged.summary = {
        layers: new Set([
            ...prompt.flatMap((item) => item?.layers ?? []),
            ...completion.flatMap((item) => item?.layers ?? []),
        ].map((item) => item?.layer).filter(Number.isInteger)).size,
        top_readouts: [
            ...prompt.flatMap((item) => item?.layers ?? []),
            ...completion.flatMap((item) => item?.layers ?? []),
        ].reduce((count, item) => count + (Array.isArray(item?.top) ? item.top.length : 0), 0),
    };
    return merged;
}

function buildGenerationId({ chatId, messageId, swipeId, promptData, text }) {
    const seed = JSON.stringify({
        chatId,
        messageId,
        swipeId,
        createdAt: nowIso(),
        prompt: promptData?.finalPrompt || promptData?.rawPrompt || '',
        text: text || '',
    });
    return `jspace_${getStringHash(seed)}_${Date.now()}`;
}

async function saveRecord(record) {
    await recordStore.setItem(record.id, record);
}

async function loadRecord(generationId) {
    if (!generationId) {
        return null;
    }

    return await recordStore.getItem(generationId);
}

function getSelectedMessageId() {
    if (Number.isInteger(renderState.messageId) && renderState.messageId >= 0) {
        return renderState.messageId;
    }

    const assistantMessageId = [...chat.keys()].reverse().find((index) => chat[index] && !chat[index].is_user && !chat[index].extra?.isSmallSys);
    return Number.isInteger(assistantMessageId) ? assistantMessageId : null;
}

function getStoredSelection() {
    const selection = chat_metadata?.[JSPACE_SELECTION_KEY];
    if (!selection || typeof selection !== 'object') {
        return null;
    }

    return {
        messageId: Number.isInteger(selection.messageId) ? selection.messageId : null,
        swipeIds: Array.isArray(selection.swipeIds) ? selection.swipeIds.map(Number).filter(Number.isInteger) : [],
    };
}

async function persistSelection(messageId, swipeIds) {
    chat_metadata[JSPACE_SELECTION_KEY] = {
        messageId,
        swipeIds: Array.isArray(swipeIds) ? swipeIds : [],
    };
    await saveMetadata();
}

function getSelectedSwipeIds(message) {
    if (!message) {
        return [];
    }

    if (Array.isArray(renderState.swipeIds) && renderState.swipeIds.length > 0) {
        return renderState.swipeIds;
    }

    const storedSelection = getStoredSelection();
    if (storedSelection?.messageId === renderState.messageId && storedSelection.swipeIds.length > 0) {
        return storedSelection.swipeIds;
    }

    return [Number(message.swipe_id ?? 0)];
}

async function createFallbackRecord(messageId, swipeId) {
    const message = getMessage(messageId);
    if (!message) {
        return null;
    }

    const text = String(message.swipes?.[swipeId] ?? message.mes ?? '');
    const swipeExtra = getSwipeExtra(message, swipeId);
    const chatId = getCurrentChatId() || 'unknown-chat';
    const record = {
        id: buildGenerationId({ chatId, messageId, swipeId, promptData: null, text }),
        chatId,
        messageId,
        swipeId,
        createdAt: nowIso(),
        reconstructed: true,
        model: {
            api: swipeExtra.api ?? message.extra?.api ?? '',
            model: swipeExtra.model ?? message.extra?.model ?? '',
        },
        promptSnapshot: {
            rawPrompt: '',
            finalPrompt: '',
            sourceSections: [],
        },
        output: {
            text,
            reasoning: String(swipeExtra.reasoning ?? ''),
        },
        capture: {
            jspace: {
                available: false,
                summary: null,
            },
            logprobs: {
                available: false,
                continueFrom: null,
                tokens: [],
            },
        },
    };

    record.contextSignature = buildContextSignature(record);
    record.captureSummary = buildCaptureSummary(record);
    record.status = buildRecordStatus(record);
    await saveRecord(record);
    setSwipeGenerationId(message, swipeId, record.id, record.status);
    return record;
}

async function ensureMessageRecords(messageId) {
    const message = getMessage(messageId);
    if (!message || !Array.isArray(message.swipes)) {
        return [];
    }

    const records = [];
    for (let swipeId = 0; swipeId < message.swipes.length; swipeId++) {
        let generationId = getSwipeGenerationId(message, swipeId);
        let record = generationId ? await loadRecord(generationId) : null;

        if (!record) {
            record = await createFallbackRecord(messageId, swipeId);
            generationId = record?.id ?? null;
        }

        if (record) {
            records.push(record);
            if (generationId) {
                setSwipeGenerationId(message, swipeId, generationId, record.status);
            }
        }
    }

    return records;
}

export function prepareJSpaceGenerationCapture({ type, mesId, promptData, requestData, api, model }) {
    // Text-generation request data contains the internal parseSequenceBreakers
    // helper. It is useful while building/sending the request, but functions
    // cannot be serialized by structuredClone for the J-space snapshot.
    const captureRequestData = requestData && typeof requestData === 'object'
        ? { ...requestData }
        : requestData;
    if (captureRequestData && typeof captureRequestData === 'object') {
        delete captureRequestData.parseSequenceBreakers;
    }

    pendingCapture = {
        type,
        messageId: mesId,
        createdAt: nowIso(),
        promptData: clone(promptData),
        requestData: clone(captureRequestData),
        api: String(api || ''),
        model: String(model || ''),
    };
    pendingJSpaceResponse = null;
}

export function setPendingJSpaceResponse(jspace) {
    pendingJSpaceResponse = mergeJSpaceCaptures(pendingJSpaceResponse, jspace);
}

export async function captureJSpaceFromSavedMessage({ type, messageId, swipes = [], preservePending = false }) {
    if (!pendingCapture) {
        return;
    }

    const message = getMessage(messageId);
    const chatId = getCurrentChatId() || 'unknown-chat';
    if (!message || !chatId) {
        if (!preservePending) {
            pendingCapture = null;
        }
        return;
    }

    const targetSwipeIds = [];
    const currentSwipeId = Number(message.swipe_id ?? 0);
    targetSwipeIds.push(currentSwipeId);

    if (Array.isArray(swipes) && swipes.length > 0) {
        const start = Math.max(0, message.swipes.length - swipes.length);
        for (let swipeId = start; swipeId < message.swipes.length; swipeId++) {
            if (!targetSwipeIds.includes(swipeId)) {
                targetSwipeIds.push(swipeId);
            }
        }
    }

    for (const swipeId of targetSwipeIds) {
        const text = String(message.swipes?.[swipeId] ?? message.mes ?? '');
        const generationId = buildGenerationId({
            chatId,
            messageId,
            swipeId,
            promptData: pendingCapture.promptData,
            text,
        });

        const swipeExtra = getSwipeExtra(message, swipeId);
        const record = {
            id: generationId,
            chatId,
            messageId,
            swipeId,
            createdAt: pendingCapture.createdAt,
            type,
            model: {
                api: pendingCapture.api || swipeExtra.api || '',
                model: pendingCapture.model || swipeExtra.model || '',
            },
            request: {
                api: pendingCapture.api,
                model: pendingCapture.model,
                summary: {
                    maxTokens: pendingCapture.requestData?.max_tokens ?? pendingCapture.requestData?.max_new_tokens ?? null,
                    logprobsRequested: pendingCapture.requestData?.logprobs ?? null,
                },
            },
            promptSnapshot: buildPromptSnapshot(pendingCapture.promptData),
            output: {
                text,
                reasoning: String(swipeExtra.reasoning ?? message.extra?.reasoning ?? ''),
            },
            capture: {
                jspace: clone(pendingJSpaceResponse) ?? { available: false, summary: null },
                logprobs: {
                    available: false,
                    continueFrom: null,
                    tokens: [],
                },
            },
        };

        record.contextSignature = buildContextSignature(record);
        record.captureSummary = buildCaptureSummary(record);
        record.status = buildRecordStatus(record);

        await saveRecord(record);
        setSwipeGenerationId(message, swipeId, generationId, record.status);
    }

    if (!preservePending) {
        pendingCapture = null;
        pendingJSpaceResponse = null;
    }
}

export async function saveJSpaceLogprobsForMessage({ messageId, swipeId, logprobs, continueFrom }) {
    const message = getMessage(messageId);
    if (!message || !Array.isArray(logprobs) || !logprobs.length) {
        return;
    }

    const generationId = getSwipeGenerationId(message, swipeId);
    if (!generationId) {
        return;
    }

    const record = await loadRecord(generationId);
    if (!record) {
        return;
    }

    record.capture = record.capture ?? {};
    record.output = record.output ?? {};
    record.output.text = String(message.swipes?.[swipeId] ?? message.mes ?? record.output.text ?? '');
    record.capture.logprobs = {
        available: true,
        continueFrom: continueFrom ?? null,
        tokens: clone(logprobs),
    };
    record.captureSummary = buildCaptureSummary(record);
    record.status = buildRecordStatus(record);

    await saveRecord(record);
    setSwipeGenerationId(message, swipeId, generationId, record.status);
}

function buildSearchResults(records, query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) {
        return [];
    }

    const results = [];
    for (const record of records) {
        const sections = record.promptSnapshot?.sourceSections ?? [];
        for (const section of sections) {
            const text = String(section.text ?? '');
            const index = text.toLowerCase().indexOf(normalized);
            if (index !== -1) {
                results.push({
                    recordId: record.id,
                    swipeId: record.swipeId,
                    label: section.label,
                    excerpt: text.substring(Math.max(0, index - 80), Math.min(text.length, index + normalized.length + 80)).trim(),
                });
            }
        }

        const outputText = String(record.output?.text ?? '');
        const outputIndex = outputText.toLowerCase().indexOf(normalized);
        if (outputIndex !== -1) {
            results.push({
                recordId: record.id,
                swipeId: record.swipeId,
                label: 'ASSISTANT',
                excerpt: outputText.substring(Math.max(0, outputIndex - 80), Math.min(outputText.length, outputIndex + normalized.length + 80)).trim(),
            });
        }
    }

    return results;
}

function buildComparisonStats(records) {
    const stats = [];
    const contexts = new Map();

    for (const record of records) {
        contexts.set(record.contextSignature, (contexts.get(record.contextSignature) || 0) + 1);
    }

    stats.push({
        label: t`Selected swipes`,
        value: String(records.length),
    });
    stats.push({
        label: t`Context groups`,
        value: String(contexts.size),
    });
    stats.push({
        label: t`J-space ready`,
        value: String(records.filter(record => record.capture?.jspace?.available).length),
    });
    stats.push({
        label: t`Logprobs ready`,
        value: String(records.filter(record => record.capture?.logprobs?.available).length),
    });

    return stats;
}

function renderTranscript(record) {
    const container = workspaceRoot.querySelector('[data-jspace="transcript"]');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const sections = record?.promptSnapshot?.sourceSections ?? [];
    const parts = [];

    sections.forEach((section) => {
        parts.push(`
            <section class="jspace-source-block">
                <div class="jspace-source-label">${escapeHtml(section.label)}</div>
                <pre class="jspace-source-text">${escapeHtml(String(section.text ?? ''))}</pre>
            </section>
        `);
    });

    parts.push(`
        <section class="jspace-source-block jspace-source-block--assistant">
            <div class="jspace-source-label">ASSISTANT</div>
            <pre class="jspace-source-text">${escapeHtml(String(record?.output?.text ?? ''))}</pre>
        </section>
    `);

    container.innerHTML = parts.join('');
}

function renderAnalysis(records) {
    const summary = workspaceRoot.querySelector('[data-jspace="analysis-summary"]');
    const comparison = workspaceRoot.querySelector('[data-jspace="analysis-compare"]');
    const gate = workspaceRoot.querySelector('[data-jspace="analysis-gate"]');
    const gateMessage = getRecordsGateMessage(records);

    if (summary instanceof HTMLElement) {
        const stats = buildComparisonStats(records);
        summary.innerHTML = stats.map((stat) => `
            <div class="jspace-stat-card">
                <div class="jspace-stat-label">${escapeHtml(stat.label)}</div>
                <div class="jspace-stat-value">${escapeHtml(stat.value)}</div>
            </div>
        `).join('');
    }

    if (comparison instanceof HTMLElement) {
        comparison.innerHTML = records.map((record) => `
            <div class="jspace-compare-row">
                <div class="jspace-compare-name">Swipe #${record.swipeId + 1}</div>
                <div class="jspace-compare-meta">${escapeHtml(record.model?.model || record.model?.api || t`Unknown model`)}</div>
                <div class="jspace-compare-meta">${escapeHtml(record.contextSignature)}</div>
            </div>
        `).join('');
    }

    if (gate instanceof HTMLElement) {
        gate.hidden = !gateMessage;
        gate.textContent = gateMessage;
    }
}

function buildAnalystEvidence(records) {
    const evidence = records.map((record) => {
        const capture = record.capture?.jspace ?? {};
        const vocab = capture.vocab ?? {};
        const positions = [
            ...(capture.prompt ?? []).slice(-6).map(item => ({ kind: 'prompt', item })),
            ...(capture.completion ?? []).slice(0, 14).map(item => ({ kind: 'completion', item })),
        ];

        return {
            swipe: record.swipeId + 1,
            output: String(record.output?.text ?? '').slice(0, 1200),
            cells: positions.flatMap(({ kind, item }) => (item?.layers ?? []).slice(0, 4).map((layer) => ({
                ref: `S${record.swipeId + 1}-${kind[0].toUpperCase()}${item.position ?? item.sample_step ?? 0}-L${layer.layer ?? '?'}`,
                position: item.position ?? item.sample_step ?? 0,
                kind,
                layer: layer.layer ?? null,
                top: (layer.top ?? []).slice(0, 3).map((entry) => {
                    const tokenId = Array.isArray(entry) ? entry[0] : entry?.token_id;
                    return {
                        token: vocab[tokenId] ?? String(tokenId ?? ''),
                        token_id: tokenId,
                        logit: Array.isArray(entry) ? entry[1] : entry?.logit,
                        rank: Array.isArray(entry) ? entry[2] : entry?.rank,
                    };
                }),
            }))),
        };
    });

    return JSON.stringify(evidence);
}

function getLatestAnalystResult(records, profileId) {
    if (!profileId) {
        return null;
    }

    return records.map(record => record.analyst?.[profileId]).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

async function renderAnalyst(records) {
    const container = workspaceRoot.querySelector('[data-jspace="analyst"]');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const gateMessage = getRecordsGateMessage(records);
    let profileState;
    try {
        profileState = await getAnalystProfiles();
    } catch {
        profileState = { available: false, profiles: [], selectedProfile: '' };
    }

    const storedProfileId = getAnalystProfileId();
    const profileId = profileState.profiles.some(profile => profile.id === storedProfileId)
        ? storedProfileId
        : (profileState.profiles.some(profile => profile.id === profileState.selectedProfile) ? profileState.selectedProfile : '');
    renderState.analystProfileId = profileId;
    const latest = getLatestAnalystResult(records, profileId);
    const statusMessage = gateMessage || renderState.analystError || (!profileState.available
        ? t`Enable Connection Manager to use a separately saved analyst profile.`
        : (!profileState.profiles.length ? t`Create a saved connection profile to use it as an analyst.` : ''));
    const disabled = Boolean(gateMessage) || !profileState.available || !profileState.profiles.length || renderState.analystPending;

    container.innerHTML = `
        <div class="jspace-analyst-intro">${escapeHtml(t`Ask a separate saved connection profile to interpret the stored capture. It does not use the llama.cpp generation connection.`)}</div>
        <label class="jspace-analyst-label" for="jspace-analyst-profile">${escapeHtml(t`Analyst profile`)}</label>
        <select id="jspace-analyst-profile" class="text_pole jspace-analyst-profile" data-jspace="analyst-profile" ${disabled ? 'disabled' : ''}>
            <option value="">${escapeHtml(t`Choose a saved connection profile`)}</option>
            ${profileState.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === profileId ? 'selected' : ''}>${escapeHtml(profile.name || profile.model || profile.id)}</option>`).join('')}
        </select>
        ${statusMessage ? `<div class="jspace-analyst-status">${escapeHtml(statusMessage)}</div>` : ''}
        <div class="jspace-analyst-messages" data-jspace="analyst-messages">
            ${latest ? `
                <div class="jspace-analyst-message jspace-analyst-message--user"><div class="jspace-analyst-role">${escapeHtml(t`Question`)}</div>${escapeHtml(latest.question)}</div>
                <div class="jspace-analyst-message"><div class="jspace-analyst-role">${escapeHtml(t`Analyst`)}</div>${escapeHtml(latest.answer)}</div>
            ` : `<div class="jspace-empty">${escapeHtml(t`No interpretation has been requested for this profile yet.`)}</div>`}
        </div>
        <label class="jspace-analyst-label" for="jspace-analyst-question">${escapeHtml(t`Question`)}</label>
        <textarea id="jspace-analyst-question" class="text_pole jspace-analyst-question" data-jspace="analyst-question" rows="3" ${disabled ? 'disabled' : ''}>${escapeHtml(t`What is the strongest supported interpretation of this generation?`)}</textarea>
        <button type="button" class="menu_button jspace-analyst-submit" data-jspace-action="ask" ${disabled || !profileId ? 'disabled' : ''}>${escapeHtml(renderState.analystPending ? t`Asking...` : t`Ask analyst`)}</button>
    `;
}

async function submitAnalystQuestion() {
    const message = getMessage(getSelectedMessageId());
    const records = [];
    for (const swipeId of getSelectedSwipeIds(message)) {
        const record = await loadRecord(getSwipeGenerationId(message, swipeId));
        if (record) {
            records.push(record);
        }
    }

    const gateMessage = getRecordsGateMessage(records);
    if (gateMessage) {
        renderState.analystError = gateMessage;
        await renderWorkspace();
        return;
    }

    const profileId = getAnalystProfileId();
    const questionInput = workspaceRoot.querySelector('[data-jspace="analyst-question"]');
    const question = questionInput instanceof HTMLTextAreaElement ? questionInput.value.trim() : '';
    if (!profileId || !question) {
        renderState.analystError = !profileId ? t`Choose an analyst profile first.` : t`Enter a question for the analyst.`;
        await renderWorkspace();
        return;
    }

    renderState.analystError = '';
    renderState.analystPending = true;
    await renderWorkspace();

    try {
        const { ConnectionManagerRequestService } = await import('./extensions/shared.js');
        const response = await ConnectionManagerRequestService.sendRequest(profileId, [
            {
                role: 'system',
                content: 'You are a careful J-space evidence analyst. Treat the supplied readouts as model behavior measurements, not private thoughts. Answer only from the supplied capture. Separate observations, inferences, and limitations. Cite supporting cell refs such as [S1-C2-L4].',
            },
            {
                role: 'user',
                content: `Question: ${question}\n\nStored J-space evidence:\n${buildAnalystEvidence(records)}`,
            },
        ], 900, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
        const answer = String(response?.content ?? '').trim();
        if (!answer) {
            throw new Error('The analyst profile returned no text.');
        }

        for (const record of records) {
            record.analyst = record.analyst ?? {};
            record.analyst[profileId] = { question, answer, createdAt: nowIso() };
            await saveRecord(record);
        }
    } catch (error) {
        renderState.analystError = error?.cause?.message || error?.message || t`The analyst request failed.`;
    } finally {
        renderState.analystPending = false;
        await renderWorkspace();
    }
}

function renderEvidence(records) {
    const container = workspaceRoot.querySelector('[data-jspace="evidence"]');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const items = [];
    for (const record of records) {
        const capture = record.capture?.jspace ?? {};
        const vocab = capture.vocab ?? {};
        const readouts = [
            ...(capture.prompt ?? []).slice(-2).map(item => ({ phase: t`Prompt`, item })),
            ...(capture.completion ?? []).slice(0, 3).map(item => ({ phase: t`Completion`, item })),
        ];
        items.push(`
            <div class="jspace-evidence-row">
                <div class="jspace-evidence-title">Swipe #${record.swipeId + 1}</div>
                <div class="jspace-evidence-body">${escapeHtml(record.output?.text?.slice(0, 220) || '')}</div>
            </div>
        `);

        for (const { phase, item } of readouts) {
            for (const layer of (item?.layers ?? []).slice(0, 2)) {
                const tokens = (layer.top ?? []).slice(0, 3).map((entry) => {
                    const tokenId = Array.isArray(entry) ? entry[0] : entry?.token_id;
                    return vocab[tokenId] ?? String(tokenId ?? '');
                }).filter(Boolean).join(' | ');
                items.push(`
                    <div class="jspace-evidence-row">
                        <div class="jspace-evidence-title">${escapeHtml(phase)} ${escapeHtml(String(item.position ?? item.sample_step ?? 0))} - L${escapeHtml(String(layer.layer ?? '?'))}</div>
                        <div class="jspace-evidence-body">${escapeHtml(tokens || t`No readouts stored for this cell.`)}</div>
                    </div>
                `);
            }
        }
    }

    container.innerHTML = items.join('') || `<div class="jspace-empty">${escapeHtml(t`No evidence is available for this selection yet.`)}</div>`;
}

function renderSearch(records) {
    const container = workspaceRoot.querySelector('[data-jspace="search-results"]');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const results = buildSearchResults(records, renderState.searchQuery);
    if (!results.length) {
        const message = renderState.searchQuery
            ? t`No matches found in the stored prompt snapshot or selected swipe text.`
            : t`Search for token text or an idea across the selected swipes.`;
        container.innerHTML = `<div class="jspace-empty">${escapeHtml(message)}</div>`;
        return;
    }

    container.innerHTML = results.map((result) => `
        <div class="jspace-search-row">
            <div class="jspace-search-title">Swipe #${result.swipeId + 1} - ${escapeHtml(result.label)}</div>
            <div class="jspace-search-body">${escapeHtml(result.excerpt)}</div>
        </div>
    `).join('');
}

function renderDetails(records) {
    const container = workspaceRoot.querySelector('[data-jspace="details"]');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    container.innerHTML = records.map((record) => `
        <div class="jspace-detail-card">
            <div class="jspace-detail-heading">Swipe #${record.swipeId + 1}</div>
            <dl class="jspace-detail-grid">
                <dt>${escapeHtml(t`Generation ID`)}</dt><dd>${escapeHtml(record.id)}</dd>
                <dt>${escapeHtml(t`Context signature`)}</dt><dd>${escapeHtml(record.contextSignature)}</dd>
                <dt>${escapeHtml(t`Model`)}</dt><dd>${escapeHtml(record.model?.model || record.model?.api || '')}</dd>
                <dt>${escapeHtml(t`Captured`)}</dt><dd>${escapeHtml(record.createdAt)}</dd>
                <dt>${escapeHtml(t`J-space`)}</dt><dd>${escapeHtml(record.capture?.jspace?.available ? 'ready' : 'missing')}</dd>
                <dt>${escapeHtml(t`Logprobs`)}</dt><dd>${escapeHtml(record.capture?.logprobs?.available ? 'ready' : 'missing')}</dd>
                <dt>${escapeHtml(t`Prompt sections`)}</dt><dd>${escapeHtml(String(record.captureSummary?.source_sections ?? 0))}</dd>
            </dl>
        </div>
    `).join('');
}

function updateTabVisibility() {
    const panes = workspaceRoot.querySelectorAll('[data-jspace-pane]');
    panes.forEach((pane) => {
        const tabName = pane.getAttribute('data-jspace-pane');
        pane.classList.toggle('active', tabName === renderState.activeTab);
    });

    const tabs = workspaceRoot.querySelectorAll('[data-jspace-tab]');
    tabs.forEach((tab) => {
        const tabName = tab.getAttribute('data-jspace-tab');
        tab.classList.toggle('active', tabName === renderState.activeTab);
    });
}

function updateRegionVisibility() {
    const regions = workspaceRoot.querySelectorAll('[data-jspace-region]');
    regions.forEach((region) => {
        region.classList.toggle('active', region.getAttribute('data-jspace-region') === renderState.activeRegion);
    });

    const tabs = workspaceRoot.querySelectorAll('[data-jspace-region-tab]');
    tabs.forEach((tab) => {
        const isActive = tab.getAttribute('data-jspace-region-tab') === renderState.activeRegion;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });
}

async function renderWorkspace() {
    renderState.open = Boolean(workspaceRoot?.classList.contains('openDrawer'));
    if (!workspaceInitialized || !renderState.open) {
        return;
    }

    const messageId = getSelectedMessageId();
    renderState.messageId = messageId;

    const message = getMessage(messageId);
    const emptyState = workspaceRoot.querySelector('[data-jspace="empty"]');
    const content = workspaceRoot.querySelector('[data-jspace="content"]');
    const title = workspaceRoot.querySelector('[data-jspace="title"]');

    if (!message) {
        if (emptyState instanceof HTMLElement) {
            emptyState.hidden = false;
        }
        if (content instanceof HTMLElement) {
            content.hidden = true;
        }
        return;
    }

    await ensureMessageRecords(messageId);
    const selectedSwipeIds = getSelectedSwipeIds(message);
    renderState.swipeIds = selectedSwipeIds;
    const records = [];

    for (const swipeId of selectedSwipeIds) {
        const generationId = getSwipeGenerationId(message, swipeId);
        const record = generationId ? await loadRecord(generationId) : null;
        if (record) {
            records.push(record);
        }
    }

    if (title instanceof HTMLElement) {
        const swipeLabel = selectedSwipeIds.length > 1
            ? t`Comparing ${selectedSwipeIds.length} swipes`
            : t`Swipe #${(selectedSwipeIds[0] ?? 0) + 1}`;
        title.textContent = `${swipeLabel} - #${messageId}`;
    }

    if (emptyState instanceof HTMLElement) {
        emptyState.hidden = true;
    }
    if (content instanceof HTMLElement) {
        content.hidden = false;
    }

    renderTranscript(records[0] ?? null);
    renderAnalysis(records);
    await renderAnalyst(records);
    renderEvidence(records);
    renderSearch(records);
    renderDetails(records);
    updateTabVisibility();
    updateRegionVisibility();
}

function createWorkspaceMarkup() {
    const root = document.createElement('div');
    root.id = JSPACE_ROOT_ID;
    root.className = 'drawer-content closedDrawer jspace-workspace';
    root.innerHTML = `
        <div class="jspace-app">
            <header class="jspace-workspace__header">
                <div class="jspace-workspace__heading">
                    <div class="jspace-kicker">${escapeHtml(t`J-space workspace`)}</div>
                    <h2 class="jspace-title" data-jspace="title">${escapeHtml(t`J-space`)}</h2>
                </div>
                <div class="jspace-dev-header">${escapeHtml(t`Also Under Development`)}</div>
                <div class="jspace-header-actions">
                    <button type="button" class="menu_button menu_button_icon" data-jspace-action="refresh" title="${escapeHtml(t`Refresh this generation record`)}">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                </div>
            </header>
            <nav class="jspace-region-tabs" role="tablist" aria-label="${escapeHtml(t`J-space workspace sections`)}">
                <button type="button" class="jspace-region-tab active" role="tab" aria-selected="true" data-jspace-region-tab="transcript">${escapeHtml(t`Transcript`)}</button>
                <button type="button" class="jspace-region-tab" role="tab" aria-selected="false" data-jspace-region-tab="analysis">${escapeHtml(t`Analysis`)}</button>
                <button type="button" class="jspace-region-tab" role="tab" aria-selected="false" data-jspace-region-tab="ask">${escapeHtml(t`Ask`)}</button>
            </nav>
            <div class="jspace-empty-state" data-jspace="empty">
                ${escapeHtml(t`Select an assistant swipe to inspect its immutable generation record.`)}
            </div>
            <div class="jspace-workspace__content" data-jspace="content" hidden>
                <section class="jspace-column jspace-column--left active" data-jspace-region="transcript">
                    <div class="jspace-column__header">${escapeHtml(t`Plaintext context`)}</div>
                    <div class="jspace-column__body" data-jspace="transcript"></div>
                </section>
                <section class="jspace-column jspace-column--middle" data-jspace-region="analysis">
                    <div class="jspace-column__header">${escapeHtml(t`Static analysis`)}</div>
                    <div class="jspace-column__body">
                        <div class="jspace-stat-grid" data-jspace="analysis-summary"></div>
                        <div class="jspace-compare-list" data-jspace="analysis-compare"></div>
                        <div class="jspace-gate" data-jspace="analysis-gate" hidden></div>
                    </div>
                </section>
                <section class="jspace-column jspace-column--right" data-jspace-region="ask">
                    <div class="jspace-column__header">${escapeHtml(t`Analyst and evidence`)}</div>
                    <div class="jspace-ask-pane" data-jspace="analyst"></div>
                    <div class="jspace-evidence-pane">
                        <div class="jspace-tab-row" role="tablist" aria-label="${escapeHtml(t`Evidence workspace`)}">
                            <button type="button" class="jspace-tab active" data-jspace-tab="evidence">${escapeHtml(t`Evidence`)}</button>
                            <button type="button" class="jspace-tab" data-jspace-tab="search">${escapeHtml(t`Search`)}</button>
                            <button type="button" class="jspace-tab" data-jspace-tab="details">${escapeHtml(t`Details`)}</button>
                        </div>
                        <div class="jspace-tabpane active" data-jspace-pane="evidence">
                            <div data-jspace="evidence"></div>
                        </div>
                        <div class="jspace-tabpane" data-jspace-pane="search">
                            <input type="search" class="text_pole" data-jspace="search-input" placeholder="${escapeHtml(t`Where does X appear?`)}">
                            <div class="jspace-search-results" data-jspace="search-results"></div>
                        </div>
                        <div class="jspace-tabpane" data-jspace-pane="details">
                            <div data-jspace="details"></div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
    return root;
}

function attachWorkspaceEvents() {
    workspaceRoot.addEventListener('click', async (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target) {
            return;
        }

        const refreshButton = target.closest('[data-jspace-action="refresh"]');
        if (refreshButton) {
            await renderWorkspace();
            return;
        }

        const askButton = target.closest('[data-jspace-action="ask"]');
        if (askButton instanceof HTMLButtonElement && !askButton.disabled) {
            await submitAnalystQuestion();
            return;
        }

        const tab = target.closest('[data-jspace-tab]');
        if (tab instanceof HTMLElement) {
            renderState.activeTab = tab.getAttribute('data-jspace-tab') || 'details';
            updateTabVisibility();
            return;
        }

        const regionTab = target.closest('[data-jspace-region-tab]');
        if (regionTab instanceof HTMLElement) {
            renderState.activeRegion = regionTab.getAttribute('data-jspace-region-tab') || 'transcript';
            updateRegionVisibility();
        }
    });

    workspaceRoot.addEventListener('change', async (event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement && target.matches('[data-jspace="analyst-profile"]')) {
            renderState.analystError = '';
            await persistAnalystProfile(target.value);
            await renderWorkspace();
        }
    });

    const searchInput = workspaceRoot.querySelector('[data-jspace="search-input"]');
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', debounce(async () => {
            renderState.searchQuery = searchInput.value;
            await renderWorkspace();
        }, 150));
    }
}

function ensureTopBarButton() {
    if (document.getElementById(JSPACE_BUTTON_ID)) {
        return;
    }

    const settingsButton = document.getElementById('sys-settings-button');
    if (!settingsButton?.parentElement) {
        return;
    }

    const button = document.createElement('div');
    button.id = JSPACE_BUTTON_ID;
    button.className = 'drawer jspace-launcher';
    button.innerHTML = `
        <div class="drawer-toggle drawer-header" title="${escapeHtml(t`J-space workspace`)}">
            <div class="drawer-icon fa-solid fa-wave-square fa-fw closedIcon" title="${escapeHtml(t`J-space workspace`)}"></div>
        </div>
    `;
    button.appendChild(workspaceRoot);
    const toggle = button.querySelector('.drawer-toggle');
    toggle?.addEventListener('click', async () => {
        await doNavbarIconClick.call(toggle);
        renderState.open = workspaceRoot.classList.contains('openDrawer');
        if (renderState.open) {
            await renderWorkspace();
        }
    });
    settingsButton.insertAdjacentElement('afterend', button);
}

export async function openJSpaceWorkspace({ messageId = null, swipeIds = null } = {}) {
    renderState.messageId = Number.isInteger(messageId) ? messageId : getStoredSelection()?.messageId;
    renderState.swipeIds = Array.isArray(swipeIds) ? swipeIds.map(Number).filter(Number.isInteger) : (getStoredSelection()?.swipeIds ?? []);
    const toggle = document.querySelector(`#${JSPACE_BUTTON_ID} .drawer-toggle`);
    if (workspaceRoot && !workspaceRoot.classList.contains('openDrawer') && toggle instanceof HTMLElement) {
        await doNavbarIconClick.call(toggle);
    }
    renderState.open = workspaceRoot?.classList.contains('openDrawer') ?? false;
    await renderWorkspace();
}

export function closeJSpaceWorkspace() {
    const toggle = document.querySelector(`#${JSPACE_BUTTON_ID} .drawer-toggle`);
    if (workspaceRoot?.classList.contains('openDrawer') && toggle instanceof HTMLElement) {
        void doNavbarIconClick.call(toggle);
    }
    renderState.open = false;
}

export async function openJSpaceComparison(messageId, swipeIds) {
    renderState.messageId = messageId;
    renderState.swipeIds = swipeIds;
    await persistSelection(messageId, swipeIds);
    await openJSpaceWorkspace({ messageId, swipeIds });
}

export function getJSpaceStatusForSwipe(message, swipeId) {
    const status = message?.swipe_info?.[swipeId]?.extra?.jspace_status;
    if (status === 'ready') {
        return t`Ready`;
    }

    if (status === 'missing_jspace') {
        return t`Missing J-space`;
    }

    if (status === 'missing_prompt') {
        return t`Missing capture`;
    }

    return t`Pending`;
}

export function initJSpace() {
    if (workspaceInitialized) {
        return;
    }

    workspaceInitialized = true;
    workspaceRoot = createWorkspaceMarkup();
    attachWorkspaceEvents();
    ensureTopBarButton();
    globalThis.SillyTavern = globalThis.SillyTavern || {};
    globalThis.SillyTavern.jspace = {
        openWorkspace: openJSpaceWorkspace,
    };

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        ensureTopBarButton();
        if (renderState.open) {
            await renderWorkspace();
        }
    });
    eventSource.on(event_types.MESSAGE_SWIPED, async () => {
        if (renderState.open) {
            await renderWorkspace();
        }
    });
    eventSource.on(event_types.MESSAGE_EDITED, async () => {
        if (renderState.open) {
            await renderWorkspace();
        }
    });
    eventSource.on(event_types.MESSAGE_SWIPE_DELETED, async () => {
        if (renderState.open) {
            await renderWorkspace();
        }
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
        if (renderState.open) {
            await renderWorkspace();
        }
    });
}
