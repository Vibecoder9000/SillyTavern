import { DiffMatchPatch } from '../lib.js';

const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;
const TOKEN_ALIGNMENT_TIMEOUT_SECONDS = 0.1;
const DEFAULT_REFINEMENT_TIMEOUT_SECONDS = 0.05;
const DEFAULT_LOCAL_GAP_CHARACTERS = 32;
const FIRST_TOKEN_CODE = 1;
const SURROGATE_START = 0xD800;
const SURROGATE_END = 0xDFFF;
const MAX_TOKEN_CODE = 0xFFFF;

function tokenCode(index) {
    let code = FIRST_TOKEN_CODE + index;
    if (code >= SURROGATE_START) code += SURROGATE_END - SURROGATE_START + 1;
    return code <= MAX_TOKEN_CODE ? code : null;
}

function tokenize(text) {
    return String(text ?? '').match(/[^\s]+(?:\s+|$)|\s+/gu) || [];
}

function encodeTokens(beforeText, afterText) {
    const tokens = new Map();
    const tokenIds = new Map();
    let nextTokenIndex = 0;
    const encode = text => {
        let encoded = '';
        for (const token of tokenize(text)) {
            let id = tokenIds.get(token);
            if (id === undefined) {
                const code = tokenCode(nextTokenIndex++);
                if (code === null) return null;
                id = code;
                tokenIds.set(token, id);
                tokens.set(id, token);
            }
            encoded += String.fromCharCode(id);
        }
        return encoded;
    };
    const before = encode(beforeText);
    const after = before === null ? null : encode(afterText);
    return before === null || after === null ? null : { before, after, tokens };
}

function mergeAdjacentDiffs(diffs) {
    const merged = [];
    for (const [operation, rawText] of diffs) {
        const text = String(rawText || '');
        if (!text) continue;
        const previous = merged.at(-1);
        if (previous?.[0] === operation) previous[1] += text;
        else merged.push([operation, text]);
    }
    return merged;
}

function tokenAnchoredDiff(beforeText, afterText) {
    const encoded = encodeTokens(beforeText, afterText);
    if (!encoded) return null;
    const differ = new DiffMatchPatch();
    // The token stream is substantially smaller than the source text, so it gets a
    // larger budget than character refinement without letting a pathological full
    // rewrite monopolize the main thread.
    differ.Diff_Timeout = TOKEN_ALIGNMENT_TIMEOUT_SECONDS;
    return differ.diff_main(encoded.before, encoded.after, false).map(([operation, text]) => [
        operation,
        Array.from(text, character => encoded.tokens.get(character.charCodeAt(0))).join(''),
    ]);
}

function refinedReplacementDiff(beforeText, afterText, timeoutSeconds) {
    if (!beforeText) return afterText ? [[DIFF_INSERT, afterText]] : [];
    if (!afterText) return [[DIFF_DELETE, beforeText]];
    const differ = new DiffMatchPatch();
    differ.Diff_Timeout = timeoutSeconds;
    const diffs = differ.diff_main(beforeText, afterText, false);
    differ.diff_cleanupSemantic(diffs);
    return diffs;
}

function refineTokenDiffs(diffs, timeoutSeconds) {
    const refined = [];
    for (let index = 0; index < diffs.length;) {
        const [operation, text] = diffs[index];
        if (operation === DIFF_EQUAL) {
            refined.push([operation, text]);
            index++;
            continue;
        }
        let removed = '';
        let added = '';
        while (index < diffs.length && diffs[index][0] !== DIFF_EQUAL) {
            const [changeOperation, changeText] = diffs[index++];
            if (changeOperation === DIFF_DELETE) removed += changeText;
            if (changeOperation === DIFF_INSERT) added += changeText;
        }
        refined.push(...refinedReplacementDiff(removed, added, timeoutSeconds));
    }
    return mergeAdjacentDiffs(refined);
}

function characterDiff(beforeText, afterText, timeoutSeconds) {
    const differ = new DiffMatchPatch();
    differ.Diff_Timeout = timeoutSeconds;
    const diffs = differ.diff_main(beforeText, afterText);
    differ.diff_cleanupSemantic(diffs);
    return mergeAdjacentDiffs(diffs);
}

function atomicParts(diffs) {
    const parts = [];
    let beforePosition = 0;
    let afterPosition = 0;
    for (let index = 0; index < diffs.length;) {
        const [operation, text] = diffs[index];
        if (operation === DIFF_EQUAL) {
            parts.push({
                type: 'equal',
                text,
                beforeStart: beforePosition,
                beforeEnd: beforePosition + text.length,
                afterStart: afterPosition,
                afterEnd: afterPosition + text.length,
            });
            beforePosition += text.length;
            afterPosition += text.length;
            index++;
            continue;
        }
        const change = {
            type: 'change',
            beforeStart: beforePosition,
            afterStart: afterPosition,
            removed: '',
            added: '',
        };
        while (index < diffs.length && diffs[index][0] !== DIFF_EQUAL) {
            const [changeOperation, changeText] = diffs[index++];
            if (changeOperation === DIFF_DELETE) {
                change.removed += changeText;
                beforePosition += changeText.length;
            } else if (changeOperation === DIFF_INSERT) {
                change.added += changeText;
                afterPosition += changeText.length;
            }
        }
        change.beforeEnd = beforePosition;
        change.afterEnd = afterPosition;
        parts.push(change);
    }
    return parts;
}

function isLocalGap(part, maximumCharacters) {
    return part?.type === 'equal'
        && !part.text.includes('\n')
        && Array.from(part.text).length <= maximumCharacters;
}

function groupLocalChanges(beforeText, afterText, atomic, maximumCharacters) {
    const parts = [];
    let hunkIndex = 0;
    for (let index = 0; index < atomic.length;) {
        const part = atomic[index];
        if (part.type === 'equal') {
            parts.push(part);
            index++;
            continue;
        }
        const segments = [part];
        let lastChange = part;
        index++;
        while (
            index + 1 < atomic.length
            && isLocalGap(atomic[index], maximumCharacters)
            && atomic[index + 1].type === 'change'
        ) {
            segments.push(atomic[index], atomic[index + 1]);
            lastChange = atomic[index + 1];
            index += 2;
        }
        const beforeStart = part.beforeStart;
        const afterStart = part.afterStart;
        const beforeEnd = lastChange.beforeEnd;
        const afterEnd = lastChange.afterEnd;
        parts.push({
            type: 'hunk',
            index: hunkIndex++,
            beforeStart,
            beforeEnd,
            afterStart,
            afterEnd,
            removed: beforeText.slice(beforeStart, beforeEnd),
            added: afterText.slice(afterStart, afterEnd),
            segments,
        });
    }
    return parts;
}

/**
 * Builds locally grouped inline diff hunks while retaining exact unchanged text as
 * neutral segments. Positions are UTF-16 offsets so callers can splice JS strings.
 */
export function computeCharacterCardDiff(before, after, {
    refinementTimeoutSeconds = DEFAULT_REFINEMENT_TIMEOUT_SECONDS,
    localGapCharacters = DEFAULT_LOCAL_GAP_CHARACTERS,
} = {}) {
    const beforeText = String(before ?? '');
    const afterText = String(after ?? '');
    if (beforeText === afterText) {
        return beforeText ? [{
            type: 'equal',
            text: beforeText,
            beforeStart: 0,
            beforeEnd: beforeText.length,
            afterStart: 0,
            afterEnd: afterText.length,
        }] : [];
    }
    const anchored = tokenAnchoredDiff(beforeText, afterText);
    const diffs = anchored
        ? refineTokenDiffs(anchored, refinementTimeoutSeconds)
        : characterDiff(beforeText, afterText, refinementTimeoutSeconds);
    return groupLocalChanges(beforeText, afterText, atomicParts(diffs), Math.max(0, localGapCharacters));
}
