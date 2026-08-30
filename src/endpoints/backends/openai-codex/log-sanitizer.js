const BASE64_VALUE_KEYS = new Set(['b64_json', 'data', 'encrypted_content', 'image', 'image_url', 'signature']);
const INLINE_BASE64_PATTERN = /data:[^,\s"']*;base64,[A-Za-z0-9+/_=-]+/gi;

function isLongBase64(value, key) {
    return value.length > 256
        && BASE64_VALUE_KEYS.has(key)
        && /^[A-Za-z0-9+/_=-]+$/.test(value);
}

/**
 * Clone a Codex request or response for terminal logging without dumping inline
 * media or encrypted payloads. The object sent over the wire is never changed.
 * @param {any} value Value to sanitize
 * @param {string} key Parent property name
 * @returns {any} Sanitized clone
 */
export function sanitizeCodexLogValue(value, key = '') {
    if (typeof value === 'string') {
        if (/^data:[^,]*;base64,/i.test(value) || isLongBase64(value, key)) {
            return '[base64 omitted]';
        }
        return value.replace(INLINE_BASE64_PATTERN, '[base64 omitted]');
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeCodexLogValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            sanitizeCodexLogValue(childValue, childKey),
        ]));
    }
    return value;
}
