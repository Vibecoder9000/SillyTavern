// Holds the in-flight World Sim run so the (now visible, non-stealth) tool-call
// `action` callbacks can chain selector -> updater and record the cycle once it
// resolves. A run is event-driven: firing the selector generation starts it, and
// each tool call's execution drives the next step. Only one run is tracked at a time.

/**
 * @typedef {'continue'|'guided'|'initialize'|'commit'|'branch'} RunMode
 */

/**
 * @typedef {object} RunContext
 * @property {RunMode} mode
 * @property {string} cycleId
 * @property {string[]} characterIds  Selected (continue) or target (initialize/commit) character ids.
 * @property {Record<string, number>} [dice] Per-character dice rolled for a continue run, keyed by character id.
 * @property {object|null} snapshot  Pre-update world snapshot, for revert.
 * @property {object|null} selectorResult
 * @property {string|null} baseRevisionId
 * @property {string|null} expectedHeadId
 * @property {object|null} baseSnapshot
 * @property {string} [guidance]
 * @property {string[]} [includedCharacterIds]
 * @property {string[]} [excludedCharacterIds]
 * @property {boolean} [exactCharacterSelection]
 */

/** @type {RunContext|null} */
let current = null;
let completion = null;

/**
 * @param {RunContext} context
 */
export function beginRun(context) {
    completion?.resolve({ status: 'superseded', cycleId: current?.cycleId || null });
    current = context;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    completion = { cycleId: context.cycleId, promise, resolve, settled: false };
    return promise;
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

/**
 * Resolves the driver waiting for a run without discarding its retryable tool scope.
 * @param {object} outcome
 */
export function pauseRun(outcome) {
    if (!completion || completion.settled) return;
    completion.settled = true;
    completion.resolve({ status: 'paused', cycleId: current?.cycleId || null, ...outcome });
}

/**
 * @param {object} [outcome]
 */
export function endRun(outcome = {}) {
    if (completion && !completion.settled) {
        completion.settled = true;
        completion.resolve({ status: 'complete', cycleId: current?.cycleId || null, ...outcome });
    }
    current = null;
    completion = null;
}

/**
 * Builds a timestamp-based cycle id used to key cycles and snapshots.
 * @returns {string}
 */
export function generateCycleId() {
    const now = new Date();
    return `${now.toISOString().slice(0, 10)}_${String(now.getUTCHours()).padStart(2, '0')}-${String(now.getUTCMinutes()).padStart(2, '0')}-${String(now.getUTCSeconds()).padStart(2, '0')}`;
}
