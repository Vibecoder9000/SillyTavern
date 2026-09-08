import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// By default the suite boots its own server instance so it never contends with a
// running one for user data: a dedicated port and a throwaway data root in the OS
// temp dir. Point ST_BASE_URL (or PLAYWRIGHT_BASE_URL) at an existing server to
// test against it instead — note that in that mode the tests operate on that
// instance's real user data.
//
// The data root is kept between runs (first boot pays a full seeding pass, which
// blocks app init for over a minute); set ST_E2E_FRESH=1 to wipe it for a clean
// slate.
const externalBaseURL = process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL || 'http://127.0.0.1:8100';
const dataRoot = path.join(os.tmpdir(), 'sillytavern-e2e-data');
if (!externalBaseURL && process.env.ST_E2E_FRESH) {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
// The workspace runtime persists tab/session state that references real chats; a
// state file carried into a fresh data root stalls the shell's boot handshake, so
// always start the isolated server with clean workspace state.
if (!externalBaseURL) {
    fs.rmSync(path.join(dataRoot, 'default-user', 'chat-workspace.json'), { force: true });
}
const e2eConfigPath = fileURLToPath(new URL('./e2e.config.yaml', import.meta.url));

export default defineConfig({
    testMatch: '*.e2e.js',
    timeout: 120_000,
    use: {
        baseURL,
        // Run the full Chromium build in new-headless mode instead of the separate
        // headless shell binary, which is not installed in the browser cache.
        channel: 'chromium',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 4,
    fullyParallel: true,
    ...(externalBaseURL ? {} : {
        webServer: {
            // The server resolves ./config.yaml relative to its working directory, so
            // always point it at the dedicated e2e config via an absolute path.
            command: 'node ../server.js --configPath "' + e2eConfigPath + '" --port 8100 --dataRoot "' + dataRoot + '" --listen=false --browserLaunchEnabled=false --basicAuthMode=false',
            url: baseURL,
            reuseExistingServer: false,
            timeout: 240_000,
            stdout: 'pipe',
            stderr: 'pipe',
        },
    }),
});
