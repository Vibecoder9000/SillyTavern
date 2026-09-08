import { test, expect } from '@playwright/test';

test.describe('boot smoke', () => {
    test('app boots with a clean console', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error));

        await page.goto('/');
        // This fork hides the preloader in place rather than removing it from the DOM.
        await page.waitForFunction(() => {
            const preloader = document.getElementById('preloader');
            return !preloader || preloader.hidden || getComputedStyle(preloader).display === 'none';
        }, { timeout: 120_000 });

        // The app UI lives inside the chat workspace child iframe.
        const child = page.frameLocator('main iframe');
        await expect(child.locator('#send_textarea')).toBeVisible({ timeout: 30_000 });
        await expect(child.locator('#chat')).toBeVisible();

        // Give deferred startup work (extensions, workspace shell) a moment to settle.
        await page.waitForTimeout(3_000);
        expect(pageErrors).toEqual([]);
    });
});
