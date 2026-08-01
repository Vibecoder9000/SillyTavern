const FIELD_ALIASES = new Map([
    ['personality', { id: 'summary', index: null }],
    ['personality/summary', { id: 'summary', index: null }],
    ['post-history instructions', { id: 'postHistory', index: null }],
    ['post history instructions', { id: 'postHistory', index: null }],
    ['character note', { id: 'characterNote', index: null }],
    ['first greeting', { id: 'greetings', index: 0 }],
]);

export function normalizeCharacterDesignerFieldLabel(label) {
    return String(label || '').trim().toLowerCase().replaceAll('’', "'").replace(/[‐‑‒–—]/g, '-');
}

/**
 * Resolve Character Designer terminology that differs from the editor's labels.
 * Collection indexes are zero-based after resolution.
 * @param {string} label
 * @returns {{id: string, index: number|null}|null}
 */
export function resolveCharacterDesignerFieldAlias(label) {
    const normalized = normalizeCharacterDesignerFieldLabel(label);
    const alias = FIELD_ALIASES.get(normalized);
    if (alias) return { ...alias };

    const alternateGreeting = normalized.match(/^alternate greeting\s+(\d+)$/);
    if (alternateGreeting) {
        const number = Number(alternateGreeting[1]);
        return number >= 1 ? { id: 'greetings', index: number } : null;
    }

    const numbered = normalized.match(/^(greeting|example|example message)\s+(\d+)$/);
    if (!numbered) return null;
    const number = Number(numbered[2]);
    if (number < 1) return null;
    return {
        id: numbered[1].startsWith('example') ? 'examples' : 'greetings',
        index: number - 1,
    };
}
