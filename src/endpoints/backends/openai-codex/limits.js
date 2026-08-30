const limitCache = new Map();

function normalizeLimitId(value) {
    return String(value || 'codex').trim().toLowerCase().replaceAll('-', '_');
}

function parseNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function parseBoolean(value) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return null;
}

function parseWindow(headers, prefix, name) {
    const usedPercent = parseNumber(headers.get(`${prefix}-${name}-used-percent`));
    if (usedPercent === null) return null;
    return {
        usedPercent,
        windowMinutes: parseNumber(headers.get(`${prefix}-${name}-window-minutes`)),
        resetsAt: parseNumber(headers.get(`${prefix}-${name}-reset-at`)),
    };
}

function cacheKey(userHandle, accountId) {
    return `${userHandle}:${accountId}`;
}

export function readObservedLimits(userHandle, accountId) {
    return limitCache.get(cacheKey(userHandle, accountId)) ?? [];
}

export function clearObservedLimits(userHandle, accountId) {
    limitCache.delete(cacheKey(userHandle, accountId));
}

export function updateObservedLimitsFromHeaders(userHandle, accountId, headers) {
    const ids = new Set(['codex']);
    for (const [headerName] of headers) {
        const match = /^x-(.+)-primary-used-percent$/i.exec(headerName);
        if (match) ids.add(normalizeLimitId(match[1]));
    }

    const snapshots = [];
    for (const id of ids) {
        const wireId = id.replaceAll('_', '-');
        const prefix = `x-${wireId}`;
        const primary = parseWindow(headers, prefix, 'primary');
        const secondary = parseWindow(headers, prefix, 'secondary');
        const hasCredits = parseBoolean(headers.get('x-codex-credits-has-credits'));
        const unlimited = parseBoolean(headers.get('x-codex-credits-unlimited'));
        const balance = headers.get('x-codex-credits-balance');
        const credits = id !== 'codex' || (hasCredits === null && unlimited === null && balance === null)
            ? null
            : { hasCredits, unlimited, balance };
        if (!primary && !secondary && !credits) continue;
        snapshots.push({
            limitId: id,
            limitName: headers.get(`${prefix}-limit-name`) || null,
            primary,
            secondary,
            credits,
        });
    }

    if (snapshots.length > 0) {
        limitCache.set(cacheKey(userHandle, accountId), snapshots.map(snapshot => ({ ...snapshot, updatedAt: Date.now() })));
    }
}

export function updateObservedLimitsFromEvent(userHandle, accountId, event) {
    if (event?.type !== 'codex.rate_limits') return;
    const snapshot = {
        limitId: normalizeLimitId(event.metered_limit_name || event.limit_name),
        limitName: event.limit_name || event.metered_limit_name || null,
        primary: event.rate_limits?.primary ? {
            usedPercent: Number(event.rate_limits.primary.used_percent),
            windowMinutes: event.rate_limits.primary.window_minutes ?? null,
            resetsAt: event.rate_limits.primary.reset_at ?? null,
        } : null,
        secondary: event.rate_limits?.secondary ? {
            usedPercent: Number(event.rate_limits.secondary.used_percent),
            windowMinutes: event.rate_limits.secondary.window_minutes ?? null,
            resetsAt: event.rate_limits.secondary.reset_at ?? null,
        } : null,
        credits: event.credits ? {
            hasCredits: event.credits.has_credits ?? null,
            unlimited: event.credits.unlimited ?? null,
            balance: event.credits.balance ?? null,
        } : null,
        updatedAt: Date.now(),
    };
    const key = cacheKey(userHandle, accountId);
    const current = limitCache.get(key) ?? [];
    const index = current.findIndex(item => item.limitId === snapshot.limitId);
    if (index === -1) current.push(snapshot);
    else current[index] = snapshot;
    limitCache.set(key, current);
}
