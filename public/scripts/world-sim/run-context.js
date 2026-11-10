// Holds the in-flight World Sim run so the (now visible, non-stealth) tool-call
// `action` callbacks can chain selector -> updater and record the cycle once it
// resolves. A run is event-driven: firing the selector generation starts it, and
// each tool call's execution drives the next step. Only one run is tracked at a time.
//
// The run also carries a `stage` the UI subscribes to (see `onRunChange`). A run that
// stalls, is stopped or fails keeps its stage (and its retryable tool scope) until the
// user retries or aborts it; it never silently turns back into "ready".

/**
 * @typedef {'continue'|'guided'|'initialize'|'commit'|'branch'} RunMode
 * @typedef {'selecting'|'selection-ready'|'preparing-context'|'updating'|'committed'|'waiting-for-user'|'stalled'|'stopped'|'failed'} RunStage
 */

/**
 * @typedef {object} RunContext
 * @property {RunMode} mode
 * @property {RunStage} [stage]
 * @property {string} [stageNote]  Extra detail for the stage (tool name, failure reason...).
 * @property {RunStage} [resumeStage] Stage the run was in when it stalled/stopped (what Retry redoes).
 * @property {boolean} [detached] The driver finished (paused) but the run is still alive.
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
 * @property {object} [driver]  Data the retry driver needs (snapshot, guidance, transcript...).
 * @property {{chatKey: string, name: string}|null} [returnTo] Chat that was open before the run.
 */

/** @type {RunContext|null} */
let current = null;
let completion = null;
/** Outcome of the most recent run that ended, so the UI can keep showing its result. */
let lastRun = null;
let selectionGate = null;
let resumer = null;
const listeners = new Set();

function emit() {
    for (const listener of [...listeners]) {
        try {
            listener(getRunState());
        } catch (error) {
            console.error('[world-sim] run listener failed', error);
        }
    }
}

/**
 * Subscribes to run changes (begin / update / pause / end / stage changes).
 * @param {(state: ReturnType<typeof getRunState>) => void} listener
 * @returns {() => void} Unsubscribe function.
 */
export function onRunChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The live run if there is one, otherwise the last finished run.
 */
export function getRunState() {
    if (current) return { active: true, run: current };
    return { active: false, run: lastRun };
}

/**
 * @param {RunContext} context
 */
export function beginRun(context) {
    completion?.resolve({ status: 'superseded', cycleId: current?.cycleId || null });
    releaseSelectionGate(false);
    lastRun = null;
    current = { stage: context.mode === 'initialize' ? 'preparing-context' : context.mode === 'commit' ? 'updating' : 'selecting', ...context };
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    completion = { cycleId: context.cycleId, promise, resolve, settled: false };
    emit();
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
    if (!current) return;
    Object.assign(current, patch);
    emit();
}

/**
 * Sets the run's stage (and optional note).
 * @param {RunStage} stage
 * @param {string} [note]
 */
export function setRunStage(stage, note = '') {
    updateRun({ stage, stageNote: note });
}

/**
 * Gives a paused run a fresh completion promise so a retry driver can take it over.
 * @returns {Promise<object>|null}
 */
export function rearmRun() {
    if (!current) return null;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    completion = { cycleId: current.cycleId, promise, resolve, settled: false };
    current.detached = false;
    emit();
    return promise;
}

/**
 * Resolves the driver waiting for a run without discarding its retryable tool scope.
 * The run stays alive and visible at `stage` ('stalled' unless stated) until retried or aborted.
 * @param {object} outcome
 */
export function pauseRun(outcome = {}) {
    const stage = outcome.stage || (outcome.status === 'cancelled' ? 'stopped' : 'stalled');
    if (current) {
        current.resumeStage = current.stage === 'stalled' || current.stage === 'stopped' ? current.resumeStage : current.stage;
        current.stage = stage;
        current.stageNote = outcome.reason || '';
        current.detached = true;
    }
    releaseSelectionGate(false);
    if (completion && !completion.settled) {
        completion.settled = true;
        completion.resolve({ status: 'paused', cycleId: current?.cycleId || null, ...outcome });
    }
    emit();
}

/**
 * @param {object} [outcome]
 */
export function endRun(outcome = {}) {
    const status = outcome.status || 'complete';
    if (completion && !completion.settled) {
        completion.settled = true;
        completion.resolve({ status: 'complete', cycleId: current?.cycleId || null, ...outcome });
    }
    releaseSelectionGate(false);
    if (current) {
        const stage = status === 'complete' ? 'committed' : status === 'failed' ? 'failed' : 'stopped';
        lastRun = {
            mode: current.mode,
            cycleId: current.cycleId,
            characterIds: outcome.characterIds || current.characterIds || [],
            guidance: current.guidance,
            returnTo: current.returnTo || null,
            stage,
            stageNote: outcome.reason || current.stageNote || '',
            summary: outcome.summary || '',
            revisionId: outcome.revisionId || null,
            status,
        };
    }
    current = null;
    completion = null;
    emit();
}

function releaseSelectionGate(value) {
    const gate = selectionGate;
    selectionGate = null;
    gate?.(value);
}

/**
 * Resolves true when the user approves the reviewed selection, false when the run is
 * paused, aborted or superseded.
 * @returns {Promise<boolean>}
 */
export function waitForSelectionReview() {
    releaseSelectionGate(false);
    return new Promise(resolve => { selectionGate = resolve; });
}

export function approveSelection() {
    releaseSelectionGate(true);
}

/**
 * Registers the function used to continue a detached (stalled/stopped) run when its
 * scoped tool is executed from chat after the driver already gave up.
 * @param {(run: RunContext) => void} fn
 */
export function setRunResumer(fn) {
    resumer = fn;
}

export function resumeDetachedRun() {
    if (current?.detached && resumer) resumer(current);
}

/**
 * Builds a timestamp-based cycle id used to key cycles and snapshots.
 * @returns {string}
 */
export function generateCycleId() {
    const now = new Date();
    return `${now.toISOString().slice(0, 10)}_${String(now.getUTCHours()).padStart(2, '0')}-${String(now.getUTCMinutes()).padStart(2, '0')}-${String(now.getUTCSeconds()).padStart(2, '0')}`;
}
