#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const slowStartupThresholdMs = 10_000;
const serverArguments = process.argv.slice(2);

// Observe the actual ready signal. A TCP probe could catch the short-lived
// preflight listener, or an unrelated process, and report a false startup time.
function waitForReady(child, startTime) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            child.removeListener('message', onMessage);
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
        };
        const onMessage = message => {
            if (message?.type !== 'sillytavern:ready') return;
            cleanup();
            resolve(performance.now() - startTime);
        };
        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`Server exited before becoming ready (code ${code}, signal ${signal ?? 'none'}).`));
        };
        const onError = error => {
            cleanup();
            reject(error);
        };
        child.on('message', onMessage);
        child.once('exit', onExit);
        child.once('error', onError);
    });
}

const startTime = performance.now();
const server = spawn(process.execPath, ['server.js', ...serverArguments], {
    cwd: serverDirectory,
    env: {
        ...process.env,
        SILLYTAVERN_ENABLESTARTUPTIMING: 'true',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});

process.once('SIGINT', () => server.kill('SIGINT'));
process.once('SIGTERM', () => server.kill('SIGTERM'));

try {
    const elapsed = await waitForReady(server, startTime);
    const elapsedMs = Math.round(elapsed);
    const status = elapsedMs > slowStartupThresholdMs ? 'SLOW' : 'Healthy';
    console.log(`[startup-external] ${status} profile: process launch -> HTTP server ready in ${elapsedMs}ms wall (threshold ${slowStartupThresholdMs}ms)`);
} catch (error) {
    if (server.exitCode === null) server.kill();
    throw error;
}

const [code, signal] = await new Promise(resolve => server.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
process.exitCode = code ?? (signal ? 1 : 0);
