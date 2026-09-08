import { test, expect } from '@playwright/test';

test.describe('sample', () => {
    test.beforeEach(async({ page }) => {
        await page.goto('/');
        // This fork hides the preloader in place rather than removing it from the DOM.
        await page.waitForFunction(() => {
            const preloader = document.getElementById('preloader');
            return !preloader || preloader.hidden || getComputedStyle(preloader).display === 'none';
        }, { timeout: 120_000 });
    });

    test('should be titled "SillyTavern"', async ({ page }) => {
        await expect(page).toHaveTitle('SillyTavern');
    });
});
