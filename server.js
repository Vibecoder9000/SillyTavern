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
    if (globalThis.STARTUP_TIMING_ENABLED) {
        await profileStartupImport('image codecs and Jimp plugins', './src/jimp.js');
        await profileStartupImport('local Transformers/ONNX runtime', './src/transformers.js');
        await profileStartupImport('tokenizer endpoint and tokenizer runtimes', './src/endpoints/tokenizers.js');
        await profileStartupImport('MCP tools endpoint and SDK', './src/endpoints/tools.js');
        await profileStartupImport('user storage and middleware subsystem', './src/users.js');
        await profileStartupImport('Webpack runtime, configuration, and Git version lookup', './src/middleware/webpack-serve.js');
        await profileStartupImport('remaining endpoint router graph', './src/server-startup.js');
        console.log(`[startup +${Math.round(performance.now() - globalThis.SERVER_START_TIME)}ms] Importing: remaining server modules`);
        const remainingModulesStart = performance.now();
        const remainingModulesCpuStart = process.cpuUsage();
        await import('./src/server-main.js');
        const remainingModulesCpu = process.cpuUsage(remainingModulesCpuStart);
        const remainingModulesCpuMs = Math.round((remainingModulesCpu.user + remainingModulesCpu.system) / 1000);
        console.log(`[startup +${Math.round(performance.now() - globalThis.SERVER_START_TIME)}ms] Imported: remaining server modules (${Math.round(performance.now() - remainingModulesStart)}ms wall, ${remainingModulesCpuMs}ms CPU); asynchronous startup is running.`);
    } else {
        await import('./src/server-main.js');
    }
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
}
