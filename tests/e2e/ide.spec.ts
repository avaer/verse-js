// ide.spec.ts
// Browser smoke tests for the two critical IDE flows: plain Run, and the
// Debug loop (breakpoint -> pause -> inspect -> step -> continue). The
// debug flow is exactly the scenario of the paused-state race bug fixed in
// Ide.jsx, so it guards against regressions in the React/Monaco wiring.

import { expect, Page, test } from '@playwright/test';

// hello-world.verse (seeded workspace): OnBegin's first Print is line 11.
const BREAKPOINT_LINE = 11;

async function openIde(page: Page): Promise<void> {
	await page.goto('/');
	// Monaco is ready once line numbers render (hello-world.verse is the
	// default active file in a fresh workspace).
	await expect(page.locator('.monaco-editor .line-numbers').first()).toBeVisible({ timeout: 30_000 });
}

test('Run executes the active file and streams output to the console', async ({ page }) => {
	await openIde(page);

	await page.getByRole('button', { name: 'Run', exact: true }).click();

	const consoleOut = page.getByTestId('console-output');
	await expect(consoleOut.getByText('Hello, world!')).toBeVisible();
	await expect(consoleOut.getByText('2 + 2 = 4')).toBeVisible();
	await expect(consoleOut.getByText('— Finished —')).toBeVisible();
});

test('Debug pauses on a breakpoint, shows state, steps, and continues', async ({ page }) => {
	await openIde(page);

	// Set a breakpoint by clicking the line number in the gutter.
	await page
		.locator('.monaco-editor .margin .line-numbers', { hasText: String(BREAKPOINT_LINE) })
		.first()
		.click();
	await expect(page.locator('.verse-breakpoint-glyph')).toHaveCount(1);

	await page.getByRole('button', { name: 'Debug', exact: true }).click();

	// Paused state: toolbar status plus debug panel with location and stack.
	await expect(page.getByText('Paused on breakpoint')).toBeVisible();
	const panel = page.getByTestId('debug-panel');
	await expect(panel.getByText(`paused at line ${BREAKPOINT_LINE}`)).toBeVisible();
	await expect(panel.getByText('Call Stack')).toBeVisible();
	await expect(panel.getByText('OnBegin')).toBeVisible();

	// Step Over executes the Print on the breakpoint line.
	const consoleOut = page.getByTestId('console-output');
	await expect(consoleOut.getByText('Hello, world!')).toHaveCount(0);
	await page.getByRole('button', { name: 'Step Over' }).click();
	await expect(consoleOut.getByText('Hello, world!')).toBeVisible();
	await expect(panel.getByText(`paused at line ${BREAKPOINT_LINE + 1}`)).toBeVisible();

	// Continue runs to completion.
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(consoleOut.getByText('2 + 2 = 4')).toBeVisible();
	await expect(consoleOut.getByText('— Finished —')).toBeVisible();
	await expect(page.getByText('Paused on breakpoint')).toHaveCount(0);
});
