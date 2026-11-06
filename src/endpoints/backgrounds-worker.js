import { parentPort, workerData } from 'node:worker_threads';

// Config path must be set before the rest of the module graph loads; fetch patch lets WASM codecs load.
const { setConfigFilePath } = await import('../util.js');
setConfigFilePath(workerData.configPath);
await import('../fetch-patch.js');
const { processBackgroundFile } = await import('./backgrounds-manager.js');

parentPort.on('message', async ({ id, args }) => {
    try {
        const result = await processBackgroundFile(...args);
        parentPort.postMessage({ id, result });
    } catch (error) {
        parentPort.postMessage({ id, error: String(error?.message ?? error) });
    }
});
