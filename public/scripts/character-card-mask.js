export const CHARACTER_CARD_MASK_SENTINEL = '⟦MASKED⟧';

/**
 * Normalize, sort, and merge character offsets used to hide model-visible text.
 * @param {string} value
 * @param {{start:number,end:number}[]} ranges
 */
export function normalizeCharacterCardMaskRanges(value, ranges) {
    const length = String(value ?? '').length;
    const normalized = (Array.isArray(ranges) ? ranges : [])
        .map(range => ({ start: Math.max(0, Math.min(length, Number(range?.start) || 0)), end: Math.max(0, Math.min(length, Number(range?.end) || 0)) }))
        .filter(range => range.end > range.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const range of normalized) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push(range);
    }
    return merged;
}

/** Replace every hidden span with one unambiguous, model-visible sentinel. */
export function maskCharacterCardText(value, ranges) {
    const source = String(value ?? '');
    const normalized = normalizeCharacterCardMaskRanges(source, ranges);
    let result = '';
    let offset = 0;
    for (const range of normalized) {
        result += source.slice(offset, range.start) + CHARACTER_CARD_MASK_SENTINEL;
        offset = range.end;
    }
    return result + source.slice(offset);
}

/**
 * Restore opaque spans after a model edit and return their new offsets.
 *
 * An exact sentinel round-trip means the model left the opaque spans untouched,
 * so their original values are restored. A changed sentinel count means the
 * model supplied replacement content (or otherwise rewrote the masked region),
 * so the result is accepted as-is and the masks are cleared. There is no safe
 * way to associate a subset of repeated sentinels with source spans after a
 * rewrite, and rejecting the whole edit would force an unnecessarily expensive
 * retry for a valid replacement. Extra sentinels are still rejected because
 * they cannot represent source content and must not be saved into the card.
 */
export function restoreCharacterCardMasks(modelText, sourceText, ranges) {
    const source = String(sourceText ?? '');
    const normalized = normalizeCharacterCardMaskRanges(source, ranges);
    const hidden = normalized.map(range => source.slice(range.start, range.end));
    const model = String(modelText ?? '');
    const parts = model.split(CHARACTER_CARD_MASK_SENTINEL);
    if (parts.length - 1 > hidden.length) {
        return { error: `Masked card edits must preserve each ${CHARACTER_CARD_MASK_SENTINEL} sentinel exactly once.`, code: 'masked-content-changed' };
    }
    if (parts.length - 1 < hidden.length) {
        return { text: parts.join(''), ranges: [], replaced: true };
    }
    let text = parts[0];
    const nextRanges = [];
    for (let index = 0; index < hidden.length; index++) {
        const start = text.length;
        text += hidden[index];
        nextRanges.push({ start, end: text.length });
        text += parts[index + 1];
    }
    return { text, ranges: nextRanges };
}

/**
 * Keep masks aligned after a single textarea edit. A manual edit that intersects
 * a hidden span is treated as explicit replacement and removes that mask.
 */
export function rebaseCharacterCardMaskRanges(before, after, ranges) {
    const oldText = String(before ?? '');
    const newText = String(after ?? '');
    const normalized = normalizeCharacterCardMaskRanges(oldText, ranges);
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    const delta = (newEnd - prefix) - (oldEnd - prefix);
    return normalized.flatMap(range => {
        if (range.end <= prefix) return [range];
        if (range.start >= oldEnd) return [{ start: range.start + delta, end: range.end + delta }];
        return [];
    });
}

/** Remove exact hidden values from arbitrary model-visible strings as a final guard. */
export function redactCharacterCardValues(value, hiddenValues) {
    let parts = String(value ?? '').split(CHARACTER_CARD_MASK_SENTINEL);
    for (const hidden of [...new Set((hiddenValues || []).map(String).filter(Boolean))].sort((left, right) => right.length - left.length)) {
        parts = parts.map(part => part.split(hidden).join(CHARACTER_CARD_MASK_SENTINEL));
    }
    return parts.join(CHARACTER_CARD_MASK_SENTINEL);
}
