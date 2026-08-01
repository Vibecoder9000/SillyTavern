import { sync as writeFileAtomicSync } from 'write-file-atomic';

const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100, 200, 400]);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

/**
 * Returns whether an error is the transient Windows rename failure that can
 * occur while another process briefly holds the destination file open.
 * @param {NodeJS.ErrnoException} error
 * @param {string} platform
 * @returns {boolean}
 */
export function isTransientWindowsRenameError(error, platform = process.platform) {
    return platform === 'win32' && error?.code === 'EPERM' && error?.syscall === 'rename';
}

/**
 * Writes a file atomically, retrying only transient Windows rename locks.
 * All non-transient errors, including a persistent rename failure, are
 * rethrown unchanged so callers retain the original error details.
 *
 * @param {string} filePath
 * @param {string|NodeJS.ArrayBufferView|null} data
 * @param {string|object} [options]
 * @param {{ platform?: string, sleep?: (milliseconds: number) => void, writeFile?: Function }} [dependencies]
 * @returns {void}
 */
export function writeFileAtomicSyncWithRetry(filePath, data, options, dependencies = {}) {
    const platform = dependencies.platform ?? process.platform;
    const sleep = dependencies.sleep ?? sleepSync;
    const writeFile = dependencies.writeFile ?? writeFileAtomicSync;

    for (let attempt = 0; ; attempt++) {
        try {
            return writeFile(filePath, data, options);
        } catch (error) {
            if (!isTransientWindowsRenameError(error, platform) || attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
                throw error;
            }

            sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
        }
    }
}
