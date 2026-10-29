import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test.use({ video: 'off', screenshot: 'off' });

// Opt in so the ordinary smoke suite does not repeat the full boot benchmark.
test('measure hard and normal reloads', async ({ page }, testInfo) => {
    test.skip(!process.env.ST_RELOAD_PERF, 'Set ST_RELOAD_PERF=1 to run the reload benchmark.');
    test.setTimeout(240_000);
    // Benchmark an initialized account, exclusively on the throwaway test server.
    expect(process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL).toBeFalsy();
    const settingsPath = path.join(os.tmpdir(), 'sillytavern-e2e-data', 'default-user', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.firstRun = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    await page.context().addInitScript(() => {
        performance.setResourceTimingBufferSize(3000);
        window.__reloadProfile = { longTasks: [], progress: [] };
        new PerformanceObserver(list => {
            window.__reloadProfile.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
        }).observe({ type: 'longtask', buffered: true });
        window.addEventListener('message', event => {
            if (event.data?.type === 'boot-progress') {
                window.__reloadProfile.progress.push({ at: performance.now(), data: event.data });
            }
        });
        new MutationObserver(() => {
            const loader = document.getElementById('preloader');
            if (loader && (loader.hidden || loader.style.display === 'none') && !window.__reloadProfile.readyMs) {
                window.__reloadProfile.readyMs = performance.now();
            }
        }).observe(document, { subtree: true, attributes: true, childList: true, attributeFilter: ['hidden', 'style'] });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    async function waitForReady() {
        await page.waitForFunction(() => Boolean(window.__reloadProfile?.readyMs), null, { timeout: 120_000 });
        await expect(page.frameLocator('main iframe').locator('#send_textarea')).toBeVisible();
        await expect(page.frameLocator('main iframe').locator('#chat')).toBeVisible();
    }
    await page.goto('/');
    await waitForReady();
    await page.waitForTimeout(1000);
    const samples = [];
    const rounds = Number(process.env.ST_RELOAD_ROUNDS || 7);
    for (let round = 0; round < rounds; round++) {
        // Alternate order to reduce order/temperature bias.
        for (const mode of (round % 2 ? ['normal', 'hard'] : ['hard', 'normal'])) {
            await session.send('Network.setCacheDisabled', { cacheDisabled: mode === 'hard' });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitForReady();
            const frames = [];
            for (const frame of page.frames()) {
                frames.push(await frame.evaluate(() => ({
                    url: location.href,
                    timeOrigin: performance.timeOrigin,
                    ...window.__reloadProfile,
                    navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
                    resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
                })));
            }
            const sample = { mode, round, readyMs: frames[0].readyMs, frames };
            samples.push(sample);
            console.log(`${mode} reload ${round + 1}: ${Math.round(sample.readyMs)}ms`);
            await page.waitForTimeout(500);
        }
    }
    const summary = Object.fromEntries(['hard', 'normal'].map(mode => {
        const times = samples.filter(sample => sample.mode === mode).map(sample => sample.readyMs).sort((a, b) => a - b);
        return [mode, { medianMs: times[Math.floor(times.length / 2)], minMs: times[0], maxMs: times.at(-1), samples: times.length }];
    }));
    const label = (process.env.ST_RELOAD_LABEL || 'latest').replace(/[^a-z0-9_-]/gi, '_');
    const reportPath = path.join(testInfo.project.outputDir, `reload-performance-${label}.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ summary, samples, errors }, null, 2));
    console.log(JSON.stringify(summary));
    await testInfo.attach('reload-profile', { path: reportPath, contentType: 'application/json' });
    // Keep pre-existing extension errors in the report without discarding timings.
    if (errors.length) console.warn('Page errors:', [...new Set(errors)]);
});
