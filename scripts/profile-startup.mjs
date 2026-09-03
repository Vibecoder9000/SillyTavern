#!/usr/bin/env node

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const host = '127.0.0.1';
const port = 8003;
const slowStartupThresholdMs = 10_000;
const serverArguments = process.argv.slice(2);

function isPortReachable() {
    return new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        const finish = reachable => {
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(250, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function waitForPort(child, startTime) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let probeTimer;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearInterval(probeTimer);
            child.removeListener('exit', onExit);
            callback(value);
        };

        const onExit = (code, signal) => {
            finish(reject, new Error(`Server exited before port ${port} became reachable (code ${code}, signal ${signal ?? 'none'}).`));
        };

        const probe = async () => {
            if (await isPortReachable()) {
                finish(resolve, performance.now() - startTime);
            }
        };

        child.once('exit', onExit);
        probeTimer = setInterval(probe, 50);
        probe();
    });
}

if (await isPortReachable()) {
    throw new Error(`Port ${port} is already reachable. Stop the existing server before profiling startup.`);
}

const startTime = performance.now();
const server = spawn(process.execPath, ['server.js', ...serverArguments], {
    cwd: serverDirectory,
    env: {
        ...process.env,
        SILLYTAVERN_ENABLESTARTUPTIMING: 'true',
    },
    stdio: 'inherit',
});

process.once('SIGINT', () => server.kill('SIGINT'));
process.once('SIGTERM', () => server.kill('SIGTERM'));

try {
    const elapsed = await waitForPort(server, startTime);
    const elapsedMs = Math.round(elapsed);
    const status = elapsedMs > slowStartupThresholdMs ? 'SLOW' : 'Healthy';
    console.log(`[startup-external] ${status} profile: process launch -> ${host}:${port} reachable in ${elapsedMs}ms wall (threshold ${slowStartupThresholdMs}ms)`);
} catch (error) {
    if (server.exitCode === null) server.kill();
    throw error;
}

const [code, signal] = await new Promise(resolve => server.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
process.exitCode = code ?? (signal ? 1 : 0);
