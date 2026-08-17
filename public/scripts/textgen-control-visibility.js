function parseControlTokens(value) {
    return String(value ?? '')
        .split(',')
        .map(token => token.trim())
        .filter(Boolean);
}

/**
 * Computes sampler-control visibility without reading DOM layout or styles.
 * API type and manual sampler selection are independent constraints and must
 * both allow a control for it to be shown.
 * @param {{samplers?: string, type?: string, typeMode?: string}} control
 * @param {{apiType: string, prioritizeManual: boolean, activeSamplers?: string[]}} state
 * @returns {boolean}
 */
export function isTextGenControlVisible(control, state) {
    const apiType = String(state.apiType ?? '');
    const controlTypes = parseControlTokens(control.type);
    const mode = String(control.typeMode ?? '').toLowerCase().trim();
    const typeVisible = !controlTypes.length
        || (mode === 'except'
            ? !controlTypes.includes(apiType)
            : controlTypes.includes(apiType) || controlTypes.includes('all'));

    const samplerNames = parseControlTokens(control.samplers);
    const activeSamplers = new Set(state.activeSamplers ?? []);
    const samplerVisible = !samplerNames.length
        || !state.prioritizeManual
        || samplerNames.some(name => activeSamplers.has(name));

    return typeVisible && samplerVisible;
}
