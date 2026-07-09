// landing.spec.ts
// Smoke test for the landing page: it explains the project and links
// through to the editor at /editor.

import { expect, test } from '@playwright/test';

test('landing page describes verse-js and links to the editor', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toContainText('Verse');
	await expect(page.getByText('A Verse implementation in JavaScript')).toBeVisible();

	// Features and API sections exist.
	await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'The API' })).toBeVisible();
	await expect(page.getByText('createHost', { exact: false }).first()).toBeVisible();

	// The primary CTA navigates to the editor.
	await page.getByRole('link', { name: 'Try it in the editor' }).click();
	await expect(page).toHaveURL(/\/editor$/);
	await expect(page.locator('.monaco-editor .line-numbers').first()).toBeVisible({ timeout: 30_000 });
});
