const CONTEXT_RADIUS = 60;

const normalizeLineEndings = value => String(value ?? '').replace(/\r\n?/g, '\n');

function candidateContext(source, start, end) {
    const before = source.slice(Math.max(0, start - CONTEXT_RADIUS), start);
    const match = source.slice(start, end);
    const after = source.slice(end, Math.min(source.length, end + CONTEXT_RADIUS));
    return `${start > CONTEXT_RADIUS ? '…' : ''}${before}[${match}]${after}${end + CONTEXT_RADIUS < source.length ? '…' : ''}`;
}

function exactMatches(source, requested) {
    const target = normalizeLineEndings(requested);
    if (!target) return [];
    const matches = [];
    let offset = 0;
    while (offset <= source.length - target.length) {
        const start = source.indexOf(target, offset);
        if (start < 0) break;
        const end = start + target.length;
        matches.push({ start, end, context: candidateContext(source, start, end) });
        offset = start + 1;
    }
    return matches;
}

function uniqueMatch(source, requested, label) {
    const target = normalizeLineEndings(requested);
    if (!target) return { error: `${label} is required.`, code: 'missing-argument' };
    const matches = exactMatches(source, target);
    if (!matches.length) return { error: `${label} was not found exactly in the current field.`, code: 'target-missing' };
    if (matches.length > 1) {
        return {
            error: `${label} occurs ${matches.length} times in the current field. Use a longer exact anchor.`,
            code: 'target-ambiguous',
            candidates: matches.slice(0, 3).map(match => match.context),
        };
    }
    return { match: matches[0], target };
}

export function resolveReplaceCardText(source, { find = '', replace = '' } = {}) {
    const text = normalizeLineEndings(source);
    const target = uniqueMatch(text, find, 'find');
    if (target.error) return target;
    return {
        start: target.match.start,
        end: target.match.end,
        replacement: normalizeLineEndings(replace),
        matched: target.target,
        operation: 'replace',
    };
}

export function resolveDeleteCardSpan(source, { from = '', until = '' } = {}) {
    const text = normalizeLineEndings(source);
    const startTarget = uniqueMatch(text, from, 'from');
    if (startTarget.error) return startTarget;
    const endTarget = uniqueMatch(text, until, 'until');
    if (endTarget.error) return endTarget;
    if (startTarget.match.start >= endTarget.match.start || startTarget.match.end > endTarget.match.start) {
        return {
            error: 'from must end before until begins; until is preserved by the deletion.',
            code: 'reversed-span',
        };
    }
    return {
        start: startTarget.match.start,
        end: endTarget.match.start,
        replacement: '',
        from: startTarget.target,
        until: endTarget.target,
        operation: 'delete-span',
    };
}

export function resolveInsertCardText(source, { content = '', position = '', anchor = '' } = {}) {
    const text = normalizeLineEndings(source);
    const value = normalizeLineEndings(content);
    if (!value) return { error: 'content must not be empty.', code: 'missing-argument' };
    if (!['before', 'after', 'start', 'end'].includes(position)) {
        return { error: 'position must be before, after, start, or end.', code: 'invalid-argument' };
    }
    if (['start', 'end'].includes(position)) {
        if (normalizeLineEndings(anchor)) {
            return { error: `anchor must be omitted when position is ${position}.`, code: 'invalid-argument' };
        }
        const offset = position === 'start' ? 0 : text.length;
        return { start: offset, end: offset, replacement: value, position, operation: 'insert' };
    }
    const target = uniqueMatch(text, anchor, 'anchor');
    if (target.error) return target;
    const offset = position === 'before' ? target.match.start : target.match.end;
    return {
        start: offset,
        end: offset,
        replacement: value,
        anchor: target.target,
        position,
        operation: 'insert',
    };
}
