#!/usr/bin/env node
import { CommandLineParser } from './src/command-line.js';
import { serverDirectory } from './src/server-directory.js';
import { getConfigValue } from './src/util.js';

console.log(`Node version: ${process.version}. Running in ${process.env.NODE_ENV} environment. Server directory: ${serverDirectory}`);

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;
globalThis.STARTUP_TIMING_ENABLED = getConfigValue('enableStartupTiming', false, 'boolean');
globalThis.SERVER_START_TIME = performance.now();
process.chdir(serverDirectory);

async function profileStartupImport(name, modulePath) {
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    console.log(`[startup +${Math.round(start - globalThis.SERVER_START_TIME)}ms] Importing: ${name}`);
    await import(modulePath);
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
    console.log(`[startup +${Math.round(performance.now() - globalThis.SERVER_START_TIME)}ms] Imported: ${name} (${Math.round(performance.now() - start)}ms wall, ${cpuMs}ms CPU)`);
}

try {
    // Keep the profiled path identical to normal startup. The module graph must
    // be imported as one unit; importing parts of it first changes module
    // evaluation order and makes the reported timings unrepresentative.
    if (globalThis.STARTUP_TIMING_ENABLED) {
        await profileStartupImport('server startup module graph', './src/server-main.js');
    } else {
        await import('./src/server-main.js');
    }
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
}
