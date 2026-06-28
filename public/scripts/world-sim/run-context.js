// Holds the in-flight World Sim run so the (now visible, non-stealth) tool-call
// `action` callbacks can chain selector -> updater and record the cycle once it
// resolves. A run is event-driven: firing the selector generation starts it, and
// each tool call's execution drives the next step. Only one run is tracked at a time.

/**
 * @typedef {'tick'|'initialize'|'commit'} RunMode
 */

/**
 * @typedef {object} RunContext
 * @property {RunMode} mode
 * @property {string} cycleId
 * @property {number} [tick]  For commit runs, the tick of the event being replaced.
 * @property {string[]} characterIds  Selected (tick) or target (initialize/commit) character ids.
 * @property {object|null} snapshot  Pre-update world snapshot, for revert.
 * @property {object|null} selectorResult
 */

/** @type {RunContext|null} */
let current = null;

/**
 * @param {RunContext} context
 */
export function beginRun(context) {
    current = context;
}

/**
 * @returns {RunContext|null}
 */
export function getRun() {
    return current;
}

/**
 * @param {Partial<RunContext>} patch
 */
export function updateRun(patch) {
    if (current) Object.assign(current, patch);
}

export function endRun() {
    current = null;
}

/**
 * Builds a timestamp-based cycle id used to key cycles and snapshots.
 * @returns {string}
 */
export function generateCycleId() {
    const now = new Date();
    return `${now.toISOString().slice(0, 10)}_${String(now.getUTCHours()).padStart(2, '0')}-${String(now.getUTCMinutes()).padStart(2, '0')}-${String(now.getUTCSeconds()).padStart(2, '0')}`;
}
