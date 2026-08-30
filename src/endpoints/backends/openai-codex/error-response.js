/**
 * Normalize an upstream Codex error without coupling the protocol helper to the
 * Express route. Parsed payloads can be safely sanitized before terminal logs.
 * @param {string} errorText Raw upstream response body
 * @param {string} fallbackMessage HTTP status text or provider fallback
 * @returns {{ message: string, logValue: any }} Normalized message and log value
 */
export function parseCodexErrorResponse(errorText, fallbackMessage) {
    const fallback = fallbackMessage || 'Codex request failed';
    try {
        const payload = JSON.parse(errorText);
        const message = payload?.error?.message || payload?.detail || fallback;
        return {
            message: typeof message === 'string' ? message : fallback,
            logValue: payload,
        };
    } catch {
        return { message: fallback, logValue: errorText };
    }
}
