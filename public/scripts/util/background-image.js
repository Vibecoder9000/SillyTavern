function getCssUrlSource(cssUrl) {
    const match = String(cssUrl ?? '').trim().match(/^url\(\s*(['"]?)(.*?)\1\s*\)$/i);
    return match?.[2] || null;
}

function isTransparentBackgroundUrl(source) {
    return source === '__transparent.png' || source?.endsWith('/__transparent.png');
}

/**
 * Normalizes a CSS background-image value for semantic comparisons.
 * @param {string} cssUrl CSS background-image value.
 * @param {string} [baseUrl] Base URL used to resolve relative image URLs.
 * @returns {string | null} A normalized resource URL, or null for no background.
 */
export function normalizeBackgroundImage(cssUrl, baseUrl = globalThis.location?.href || 'http://localhost/') {
    const value = String(cssUrl ?? '').trim();
    if (value === 'none') return null;

    const source = getCssUrlSource(value);
    if (!source || isTransparentBackgroundUrl(source)) return source ? null : value;

    try {
        const url = new URL(source, baseUrl);
        if (url.hash.startsWith('#st-bg-decoder-reset-')) url.hash = '';
        return url.href;
    } catch {
        return source;
    }
}

/**
 * Returns the newest transition target when one exists.
 * @param {string} currentCssUrl Current CSS background-image value.
 * @param {string[]} [transitionImages] Transition-layer background-image values in creation order.
 * @returns {string} The effective CSS background-image value.
 */
export function getEffectiveBackgroundImage(currentCssUrl, transitionImages = []) {
    return transitionImages.filter(Boolean).at(-1) ?? currentCssUrl;
}

/**
 * Compares two CSS background-image values by their effective image resource.
 * @param {string} currentCssUrl Current CSS background-image value.
 * @param {string} requestedCssUrl Requested CSS background-image value.
 * @param {string} [baseUrl] Base URL used to resolve relative image URLs.
 * @returns {boolean} Whether both values represent the same effective background.
 */
export function areBackgroundImagesEqual(currentCssUrl, requestedCssUrl, baseUrl) {
    return normalizeBackgroundImage(currentCssUrl, baseUrl) === normalizeBackgroundImage(requestedCssUrl, baseUrl);
}
