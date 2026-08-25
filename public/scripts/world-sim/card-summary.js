import {
    characters,
    cleanUpMessage,
    extractMessageFromData,
    generateRawData,
    getOneCharacter,
    getMaxPromptTokens,
    main_api,
} from '../../script.js';
import { getFriendlyTokenizerName, getTokenCountAsync } from '../tokenizers.js';
import { getStringHash } from '../utils.js';
import { parseReasoningFromString, parseReasoningStream } from '../reasoning.js';
import { getConfig, getRosterCharacter, saveWorldSimState } from './state.js';

export const CARD_CONTEXT_TOKEN_LIMIT = 4096;
const SUMMARY_PROMPT_TOKEN_LIMIT = 2048;

export class SummaryPausedError extends Error {
    constructor(characterName) {
        super(`Context generation is paused; ${characterName} still needs character context.`);
        this.name = 'SummaryPausedError';
    }
}

/**
 * Builds a stable, readable source containing the authored text in a character card.
 * Runtime chat metadata, the user persona, media, timestamps, and internal ids are omitted.
 * @param {object} character
 * @returns {string}
 */
export function buildCharacterCardSource(character) {
    if (!character) return '';
    const data = character.data || {};
    const characterName = data.name || character.name;
    const sections = [];
    const add = (label, value) => {
        let text = Array.isArray(value)
            ? value.map(item => String(item || '').trim()).filter(Boolean).join('\n\n')
            : String(value || '').trim();
        text = normalizePlainContextText(text, characterName);
        if (text) sections.push(`${label}: ${text}`);
    };

    add('Name', data.name || character.name);
    add('Description', data.description || character.description);
    add('Personality', data.personality || character.personality);
    add('Scenario', data.scenario || character.scenario);
    add('System prompt', data.system_prompt);
    add('Post-history instructions', data.post_history_instructions);
    add('Depth prompt', data.extensions?.depth_prompt?.prompt);

    const book = data.character_book;
    if (book && typeof book === 'object') {
        add('Character book name', book.name);
        add('Character book description', book.description);
        const entries = Array.isArray(book.entries) ? book.entries : [];
        for (const [index, entry] of entries.entries()) {
            if (!entry || typeof entry !== 'object' || entry.enabled === false || !entry.content) continue;
            add(entry.name || entry.comment || `Character book entry ${index + 1}`, entry.content);
        }
    }

    return normalizePlainContextText(sections.join('\n\n'), characterName);
}

function normalizePlainContextText(value, characterName = '') {
    let text = String(value || '').replace(/\r\n?/g, '\n');
    text = text
        .replace(/\{\{\s*char\s*\}\}/gi, String(characterName || 'the character'))
        .replace(/```[^\n]*\n?/g, '')
        .replace(/^\s*#{1,6}\s+/gm, '')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
        .replace(/^[A-Za-z0-9][A-Za-z0-9 '’()\/-]{0,48}:\s+/gm, '')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .replace(/[*`]+/g, '')
        .replace(/~~|__/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text;
}

function getTokenizerId() {
    const tokenizer = getFriendlyTokenizerName();
    return `${tokenizer.tokenizerKey || tokenizer.tokenizerId}:${tokenizer.tokenizerName || ''}`;
}

function findCharacter(characterId) {
    const rosterCharacter = getRosterCharacter(characterId);
    if (!rosterCharacter) return { rosterCharacter: null, character: null };
    const character = characters.find(item => item.avatar === rosterCharacter.avatar) || null;
    return { rosterCharacter, character };
}

/**
 * Returns a synchronous status for roster rendering. Token counts are stored with the cache.
 * @param {string} characterId
 */
export function getCardContextStatus(characterId) {
    const { rosterCharacter, character } = findCharacter(characterId);
    const context = rosterCharacter?.cardContext;
    if (!rosterCharacter || !character) return { state: 'missing', label: 'No card', context: null };
    if (!context?.text) return { state: 'missing', label: 'No context', context: null };

    const sourceHash = String(getStringHash(buildCharacterCardSource(character)));
    const tokenizerChanged = context.tokenizerId !== getTokenizerId();
    const sourceChanged = context.sourceHash !== sourceHash;
    const stale = sourceChanged || tokenizerChanged;

    if (context.kind === 'edited') {
        return {
            state: stale ? 'edited-stale' : 'edited',
            label: stale
                ? `${context.contextTokens || '?'} / ${CARD_CONTEXT_TOKEN_LIMIT} tokens · edited · source changed`
                : `${context.contextTokens || '?'} / ${CARD_CONTEXT_TOKEN_LIMIT} tokens · edited`,
            context,
        };
    }
    if (stale) return { state: 'stale', label: 'Needs refresh', context };
    if (context.kind === 'raw') return { state: 'raw', label: `${context.contextTokens || 0} / ${CARD_CONTEXT_TOKEN_LIMIT} tokens · full card`, context };
    return { state: 'summary', label: `${context.contextTokens || 0} / ${CARD_CONTEXT_TOKEN_LIMIT} tokens · source ${context.sourceTokens || '?'} tokens`, context };
}

/**
 * Produces or retrieves the <=4096-token context used by World Sim prompts.
 * @param {string} characterId
 * @param {{ force?: boolean, ignorePaused?: boolean, onProgress?: (message:string) => void, onStream?: (update:{reasoning:string, content:string, isThinking:boolean}) => void }} [options]
 */
export async function ensureCharacterCardContext(characterId, { force = false, ignorePaused = false, onProgress = null, onStream = null } = {}) {
    let { rosterCharacter, character } = findCharacter(characterId);
    if (!rosterCharacter || !character) throw new Error(`Character card not found for ${characterId}.`);

    // The character list may contain shallow entries when lazy loading is enabled.
    // Summaries must be built from the complete card, so hydrate through the canonical
    // character endpoint before reading any card fields.
    if (character.shallow) {
        onProgress?.(`Loading ${rosterCharacter.name}'s full card…`);
        await getOneCharacter(character.avatar);
        ({ rosterCharacter, character } = findCharacter(characterId));
        if (!rosterCharacter || !character || character.shallow) {
            throw new Error(`Failed to load the full character card for ${rosterCharacter?.name || characterId}.`);
        }
    }

    const source = buildCharacterCardSource(character);
    if (!source) throw new Error(`${rosterCharacter.name || characterId} has no textual card content.`);
    const sourceHash = String(getStringHash(source));
    const tokenizerId = getTokenizerId();
    const existing = rosterCharacter.cardContext;
    const unchanged = existing?.text && existing.sourceHash === sourceHash && existing.tokenizerId === tokenizerId;

    // User edits are authoritative. A changed card is surfaced as stale in the UI but does
    // not silently overwrite an explicit edit; Regenerate is the opt-in replacement action.
    if (!force && existing?.kind === 'edited' && existing.text) {
        const cleanedEdited = normalizePlainContextText(existing.text, rosterCharacter.name || character.name);
        if (!cleanedEdited) throw new Error(`${rosterCharacter.name}'s edited context contains no usable character information.`);
        const editedTokens = await getTokenCountAsync(cleanedEdited, 0);
        if (editedTokens > CARD_CONTEXT_TOKEN_LIMIT) {
            throw new Error(`${rosterCharacter.name}'s edited context is ${editedTokens} tokens with the current tokenizer; edit or regenerate it before continuing.`);
        }
        if (existing.text !== cleanedEdited || existing.tokenizerId !== tokenizerId || existing.contextTokens !== editedTokens) {
            existing.text = cleanedEdited;
            existing.tokenizerId = tokenizerId;
            existing.contextTokens = editedTokens;
            await saveWorldSimState();
        }
        return existing;
    }
    if (!force && unchanged) return existing;

    onProgress?.(`Counting ${rosterCharacter.name}'s card…`);
    const sourceTokens = await getTokenCountAsync(source, 0);
    let text = source;
    let kind = 'raw';

    if (sourceTokens > CARD_CONTEXT_TOKEN_LIMIT) {
        if (getConfig().summaryPaused && !ignorePaused) {
            throw new SummaryPausedError(rosterCharacter.name || characterId);
        }
        onProgress?.(`Building ${rosterCharacter.name}'s context…`);
        text = await summarizeLargeSource(source, rosterCharacter.name || character.name || characterId, onProgress, onStream);
        kind = 'summary';
    }

    onProgress?.(`Finalizing ${rosterCharacter.name}'s context…`);
    text = await capToTokenLimit(normalizePlainContextText(text, rosterCharacter.name || character.name), CARD_CONTEXT_TOKEN_LIMIT);
    const contextTokens = await getTokenCountAsync(text, 0);
    if (!text.trim()) throw new Error(`No character context was generated for ${rosterCharacter.name || characterId}.`);

    rosterCharacter.cardContext = {
        sourceHash,
        tokenizerId,
        text: text.trim(),
        sourceTokens,
        contextTokens,
        kind,
        updatedAt: new Date().toISOString(),
    };
    await saveWorldSimState();
    return rosterCharacter.cardContext;
}

/**
 * Saves a user-edited context without allowing it to exceed the World Sim budget.
 * @param {string} characterId
 * @param {string} text
 */
export async function saveEditedCardContext(characterId, text) {
    const { rosterCharacter, character } = findCharacter(characterId);
    if (!rosterCharacter || !character) throw new Error(`Character card not found for ${characterId}.`);
    text = normalizePlainContextText(text, rosterCharacter.name || character.name);
    if (!text) throw new Error('The character context cannot be empty.');
    const contextTokens = await getTokenCountAsync(text, 0);
    if (contextTokens > CARD_CONTEXT_TOKEN_LIMIT) {
        throw new Error(`The edited context is ${contextTokens} tokens; the limit is ${CARD_CONTEXT_TOKEN_LIMIT}.`);
    }

    const source = buildCharacterCardSource(character);
    rosterCharacter.cardContext = {
        sourceHash: String(getStringHash(source)),
        tokenizerId: getTokenizerId(),
        text,
        sourceTokens: await getTokenCountAsync(source, 0),
        contextTokens,
        kind: 'edited',
        updatedAt: new Date().toISOString(),
    };
    await saveWorldSimState();
    return rosterCharacter.cardContext;
}

async function summarizeLargeSource(source, characterName, onProgress, onStream, depth = 0) {
    const maxInputTokens = Math.max(1200, getMaxPromptTokens(CARD_CONTEXT_TOKEN_LIMIT + 128) - 700);
    const sourceTokens = await getTokenCountAsync(source, 0);
    if (sourceTokens <= maxInputTokens) {
        return generateSummary(source, characterName, SUMMARY_PROMPT_TOKEN_LIMIT, onStream, CARD_CONTEXT_TOKEN_LIMIT);
    }
    if (depth >= 5) throw new Error(`${characterName}'s card is too large to condense with the current context size.`);

    const chunks = await splitToTokenChunks(source, maxInputTokens);
    const partialTarget = Math.max(512, Math.min(1400, Math.floor(maxInputTokens / Math.max(2, chunks.length))));
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
        onProgress?.(`Condensing ${characterName} · part ${i + 1} of ${chunks.length}…`);
        partials.push(await generateSummary(chunks[i], characterName, partialTarget, onStream));
    }

    const combined = partials.join('\n\n');
    return summarizeLargeSource(combined, characterName, onProgress, onStream, depth + 1);
}

async function generateSummary(source, characterName, targetTokens, onStream = null, outputTokenLimit = targetTokens) {
    const systemPrompt = [
        `Produce faithful character context for ${characterName} using only the supplied source.`,
        `${targetTokens} tokens is a hard maximum, not a length target. Do not exclude, summarize away, or generalize concrete source information merely to make the result shorter.`,
        'Keep every useful specific detail that fits: identity, appearance, personality, speech patterns, behavior, motivations, relationships between actual characters, setting facts, constraints, relevant lore, and authored system, post-history, depth, and character-book instructions.',
        'Stop naturally once all useful source details have been retained. A shorter result is correct; never invent or pad to approach the limit.',
        'The user is not a character or entity in this setting and cannot be seen, contacted, addressed, remembered, or interacted with. Omit every user relationship and user placeholder.',
        'Second-person language inside authored instructions addresses the instruction recipient; preserve its meaning as instruction and never reinterpret it as an in-world user character.',
        'Omit example dialogue, greetings, creator metadata, tags, and unrelated meta commentary.',
        'Use plain prose paragraphs only. Do not use Markdown, headings, bullets, field labels, or introductory text.',
        'Do not invent, sanitize, moralize, or replace concrete details with generalizations.',
    ].join('\n');
    let message = await requestContextGeneration(source, systemPrompt, targetTokens, onStream);
    message = normalizePlainContextText(message, characterName);
    if (!message) throw new Error(`No character context was generated for ${characterName}.`);
    return capToTokenLimit(message, outputTokenLimit);
}

async function requestContextGeneration(source, systemPrompt, targetTokens, onStream) {
    const data = await generateRawData({
        prompt: source,
        systemPrompt,
        quietToLoud: true,
        stream: true,
        substituteMacros: false,
    });
    let response;
    if (typeof data === 'function') {
        response = '';
        let streamedReasoning = '';
        for await (const chunk of data()) {
            response = chunk.text || response;
            streamedReasoning = chunk.state?.reasoning || streamedReasoning;
            const parsed = parseReasoningStream(response);
            const reasoning = streamedReasoning || parsed?.reasoning || '';
            const content = parsed?.content ?? response;
            onStream?.({
                reasoning,
                content,
                isThinking: parsed
                    ? Boolean(parsed.isThinking)
                    : Boolean(streamedReasoning && !content),
            });
        }
    } else {
        response = extractMessageFromData(data, main_api);
    }
    const completedReasoning = parseReasoningFromString(response);
    if (completedReasoning?.reasoning) response = completedReasoning.content;
    const message = cleanUpMessage({
        getMessage: response,
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
        trimNames: false,
        trimWrongNames: false,
    });
    return message?.trim() || '';
}

async function splitToTokenChunks(text, maxTokens) {
    const chunks = [];
    let remaining = text;
    while (remaining) {
        if (await getTokenCountAsync(remaining, 0) <= maxTokens) {
            chunks.push(remaining);
            break;
        }

        let low = 1;
        let high = remaining.length;
        let best = 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const count = await getTokenCountAsync(remaining.slice(0, mid), 0);
            if (count <= maxTokens) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const paragraphBreak = remaining.lastIndexOf('\n\n', best);
        const cut = paragraphBreak > best * 0.6 ? paragraphBreak : best;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    return chunks.filter(Boolean);
}

async function capToTokenLimit(text, limit) {
    text = String(text || '').trim();
    if (await getTokenCountAsync(text, 0) <= limit) return text;

    let low = 1;
    let high = text.length;
    let best = 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (await getTokenCountAsync(text.slice(0, mid), 0) <= limit) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    let capped = text.slice(0, best).trimEnd();
    const sentenceEnd = Math.max(capped.lastIndexOf('.'), capped.lastIndexOf('!'), capped.lastIndexOf('?'), capped.lastIndexOf('\n'));
    if (sentenceEnd > capped.length * 0.7) capped = capped.slice(0, sentenceEnd + 1).trimEnd();
    return capped;
}
