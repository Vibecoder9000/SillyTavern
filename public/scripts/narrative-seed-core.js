/**
 * Pure logic for the narrative seed: cutting drafts into chunks and combining them.
 * This file has no imports so it can be loaded by power-user.js and by unit tests.
 */

/**
 * @typedef {object} NarrativeSeed
 * @property {number} v Format version
 * @property {string[]} drafts Raw drafts, exactly as the seed source wrote them
 * @property {number[][]} boundaries Per draft, the N+1 character offsets of its chunks
 * @property {number[]} selection Per slot, the index of the draft that fills it
 * @property {number} failed How many of the requested drafts did not arrive
 */

export const MAX_NARRATIVE_SEED_CHUNKS = 10;
export const NARRATIVE_SEED_PLACEHOLDER = '{{seed}}';

export const DEFAULT_NARRATIVE_SEED_TEMPLATE = `Each seed chunk is a fact that happens in the scene, in this order, however absurd. Play it straight and have characters react as real people would. Do not explain, justify, cut, or reframe it (no dreams, hallucinations, or "it was a joke"). If chunks contradict, keep both and let the contradiction stand. Established facts from the opening message override the seed. Do not adopt new named characters from the seed as canon unless the story keeps them.

Seed chunks:
${NARRATIVE_SEED_PLACEHOLDER}`;

export const DEFAULT_NARRATIVE_SEED_SETTINGS = Object.freeze({
    enabled: false,
    source_profile: '',
    temperature: 1.2,
    max_tokens: 200,
    chunks: 3,
    context_messages: 10,
    timeout_seconds: 30,
    pause_before_generation: false,
    template: DEFAULT_NARRATIVE_SEED_TEMPLATE,
});

/**
 * Finds the offsets that cut a text into chunks of roughly equal word count.
 * Offsets always land on the start of a word, and a text with fewer words than
 * chunks produces some empty chunks.
 * @param {string} text Draft text
 * @param {number} chunkCount Number of chunks
 * @returns {number[]} chunkCount + 1 offsets, starting at 0 and ending at text.length
 */
export function computeChunkBoundaries(text, chunkCount) {
    const wordStarts = Array.from(text.matchAll(/\S+/g), match => match.index);
    const boundaries = [0];
    for (let i = 1; i < chunkCount; i++) {
        const wordIndex = Math.floor(i * wordStarts.length / chunkCount);
        boundaries.push(wordStarts[wordIndex] ?? text.length);
    }
    boundaries.push(text.length);
    return boundaries;
}

/**
 * Gets the default selection: draft 1 fills slot 1, draft 2 fills slot 2, and so on.
 * With fewer drafts than slots, the drafts that exist are used in rotation.
 * @param {number} draftCount Number of drafts
 * @param {number} slotCount Number of slots
 * @returns {number[]} Draft index per slot
 */
export function getDefaultSelection(draftCount, slotCount) {
    return Array.from({ length: slotCount }, (_, slot) => slot % draftCount);
}

/**
 * Builds a seed from the draft request results.
 * @param {string[]} results One string per requested draft; blank means it failed
 * @param {number} chunkCount Chunks per draft
 * @returns {NarrativeSeed|null} The seed, or null if no draft arrived
 */
export function buildNarrativeSeed(results, chunkCount) {
    const drafts = results.filter(draft => typeof draft === 'string' && draft.trim().length > 0);
    if (drafts.length === 0) {
        return null;
    }
    const slotCount = Math.min(Math.max(1, Math.trunc(chunkCount) || 1), MAX_NARRATIVE_SEED_CHUNKS);
    return {
        v: 1,
        drafts,
        boundaries: drafts.map(draft => computeChunkBoundaries(draft, slotCount)),
        selection: getDefaultSelection(drafts.length, slotCount),
        failed: results.length - drafts.length,
    };
}

/**
 * Checks that stored data has the shape the seed code relies on.
 * @param {any} seed Value read from a message
 * @returns {seed is NarrativeSeed}
 */
export function isValidNarrativeSeed(seed) {
    return !!seed
        && Array.isArray(seed.drafts)
        && seed.drafts.length > 0
        && Array.isArray(seed.boundaries)
        && seed.boundaries.length === seed.drafts.length
        && Array.isArray(seed.selection)
        && seed.selection.length > 0;
}

/**
 * Gets one section of a draft.
 * @param {NarrativeSeed} seed Seed
 * @param {number} draftIndex Draft index
 * @param {number} slot Slot index
 * @returns {string} Raw section text
 */
export function getSeedChunk(seed, draftIndex, slot) {
    const draft = seed.drafts[draftIndex] ?? '';
    const boundaries = seed.boundaries[draftIndex] ?? [];
    return draft.slice(boundaries[slot] ?? 0, boundaries[slot + 1] ?? 0);
}

/**
 * Combines the selected sections, one per line. The newline is what lets the
 * main model tell chunks apart; the chunk text itself is not edited.
 * @param {NarrativeSeed} seed Seed
 * @param {number[]} [selection] Draft index per slot; defaults to the stored selection
 * @returns {string} Combined seed
 */
export function combineNarrativeSeed(seed, selection = seed.selection) {
    return selection
        .map((draftIndex, slot) => getSeedChunk(seed, draftIndex, slot).trim())
        .filter(chunk => chunk.length > 0)
        .join('\n');
}

/**
 * Puts the combined seed into the instruction template. A template without the
 * placeholder gets the seed appended, so an edited template can't lose it.
 * @param {string} template Instruction template
 * @param {string} combined Combined seed
 * @returns {string} Prompt text
 */
export function formatNarrativeSeedPrompt(template, combined) {
    if (template.includes(NARRATIVE_SEED_PLACEHOLDER)) {
        return template.replaceAll(NARRATIVE_SEED_PLACEHOLDER, () => combined);
    }
    return `${template}\n\n${combined}`;
}
