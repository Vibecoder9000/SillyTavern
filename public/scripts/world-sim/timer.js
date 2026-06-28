import { getConfig, getState, updateState, saveWorldSimState } from './state.js';
import { runCycle } from './main.js';
import { renderAll } from './ui.js';

let timerId = null;
let countdownId = null;
let lastTickAt = 0;
let countdownCallback = null;

function emitCountdownUpdate() {
    countdownCallback?.(getNextTickInMs());
}

/**
 * @returns {boolean}
 */
export function isTimerRunning() {
    return !!timerId;
}

/**
 * Starts the auto-run timer.
 */
export function startTimer() {
    stopTimer();
    const config = getConfig();
    const intervalMs = (config.tickIntervalMinutes || 10) * 60 * 1000;
    lastTickAt = Date.now();
    timerId = setInterval(() => {
        lastTickAt = Date.now();
        runCycle().then(() => renderAll()).catch(console.error);
    }, intervalMs);
    updateState({ paused: false });
    saveWorldSimState().catch(console.error);
    emitCountdownUpdate();
}

/**
 * Stops the auto-run timer.
 */
export function stopTimer() {
    if (timerId) {
        clearInterval(timerId);
        timerId = null;
    }
    updateState({ paused: true });
    saveWorldSimState().catch(console.error);
    emitCountdownUpdate();
}

/**
 * @returns {number|null}
 */
export function getNextTickInMs() {
    const state = getState();
    if (state.paused || !lastTickAt) return null;
    const config = getConfig();
    const intervalMs = (config.tickIntervalMinutes || 10) * 60 * 1000;
    return Math.max(0, lastTickAt + intervalMs - Date.now());
}

/**
 * @param {function(number|null): void} callback
 */
export function startCountdown(callback) {
    countdownCallback = callback;
    if (countdownId) clearInterval(countdownId);
    countdownId = setInterval(() => {
        emitCountdownUpdate();
    }, 1000);
    emitCountdownUpdate();
}
