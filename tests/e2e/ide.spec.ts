// ide.spec.ts
// Browser smoke tests for the two critical IDE flows: plain Run, and the
// Debug loop (breakpoint -> pause -> inspect -> step -> continue). The
// debug flow is exactly the scenario of the paused-state race bug fixed in
// Ide.jsx, so it guards against regressions in the React/Monaco wiring.

import { expect, Page, test } from '@playwright/test';

// hello-world.verse (seeded workspace): OnBegin's first Print is line 11.
const BREAKPOINT_LINE = 11;

async function openIde(page: Page): Promise<void> {
	await page.goto('/editor');
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

test('Multi-file run: the entry file calls into another workspace file', async ({ page }) => {
	await openIde(page);

	await page.getByText('multi-file-demo.verse', { exact: true }).click();
	await page.getByRole('button', { name: 'Run', exact: true }).click();

	const consoleOut = page.getByTestId('console-output');
	await expect(consoleOut.getByText('Average(3.0, 5.0) = 4.0')).toBeVisible();
	await expect(consoleOut.getByText('Lerp(0.0, 10.0, 0.25) = 2.5')).toBeVisible();
	await expect(consoleOut.getByText('GoldenRatio = 1.618034')).toBeVisible();
	await expect(consoleOut.getByText('— Finished —')).toBeVisible();
});

test('Cross-file go-to-definition opens the defining file tab', async ({ page }) => {
	await openIde(page);

	await page.getByText('multi-file-demo.verse', { exact: true }).click();

	// Place the cursor on 'Average' and trigger Go to Definition. Average
	// is defined in math-lib.verse, so the IDE switches tabs.
	await page.evaluate(() => {
		const editor = (window as unknown as { __verseEditor?: import('monaco-editor').editor.IStandaloneCodeEditor }).__verseEditor;
		if (!editor) {
			throw new Error('Monaco editor not found');
		}
		const model = editor.getModel()!;
		// Target the call site (`Avg := Average(...)`), not the mention of
		// Average inside comments/strings where no binding resolves.
		const match = model.findMatches('Average(3.0', false, false, true, null, false)[0];
		if (!match) {
			throw new Error('Average call site not found in the demo file');
		}
		editor.setPosition({
			lineNumber: match.range.startLineNumber,
			column: match.range.startColumn + 1,
		});
		editor.focus();
		editor.trigger('test', 'editor.action.revealDefinition', {});
	});

	// The tab strip now shows math-lib.verse as the active tab, with the
	// defining line revealed.
	const tabs = page.getByTestId('editor-tabs');
	await expect(tabs.getByText('math-lib.verse')).toBeVisible({ timeout: 10_000 });
	await expect(
		page.locator('.monaco-editor .view-lines').getByText('Average(A : float, B : float)'),
	).toBeVisible();
});

test('Semantic analysis runs in a Web Worker and streams live diagnostics', async ({ page }) => {
	await openIde(page);

	// The IDE spawns a dedicated analysis worker alongside Monaco's editor
	// worker as soon as the workspace loads.
	await expect
		.poll(() => page.workers().filter((w) => w.url().includes('analysis')).length)
		.toBeGreaterThan(0);

	// Replace the buffer with code that has a type error; the checker runs
	// in the worker and its diagnostics come back as squiggles.
	await page.evaluate(() => {
		const editor = (window as unknown as { __verseEditor?: import('monaco-editor').editor.IStandaloneCodeEditor }).__verseEditor;
		if (!editor) {
			throw new Error('Monaco editor not found');
		}
		editor.getModel()!.setValue('X : int = "not an int"\n');
	});
	await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();

	// Fixing the code clears the markers again.
	await page.evaluate(() => {
		const editor = (window as unknown as { __verseEditor?: import('monaco-editor').editor.IStandaloneCodeEditor }).__verseEditor;
		editor!.getModel()!.setValue('X : int = 42\n');
	});
	await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
});

test('Reset clears persistent weak_map storage', async ({ page }) => {
	await openIde(page);
	page.on('dialog', (dialog) => dialog.accept());

	const consoleOut = page.getByTestId('console-output');
	const runOnce = async () => {
		await page.getByRole('button', { name: 'Clear', exact: true }).click();
		await page.getByRole('button', { name: 'Run', exact: true }).click();
		await expect(consoleOut.getByText('— Finished —')).toBeVisible();
		const text = await consoleOut.innerText();
		const match = text.match(/best so far: (\d+)/);
		expect(match).not.toBeNull();
		return Number(match![1]);
	};

	await page.getByText('persistent-score.verse', { exact: true }).click();

	// First run starts from 0 and stores a roll (always >= 1) in the
	// persistent weak_map; the second run sees it.
	expect(await runOnce()).toBe(0);
	expect(await runOnce()).toBeGreaterThan(0);
	const storedKeys = await page.evaluate(() =>
		Object.keys(window.localStorage).filter((key) => key.startsWith('verse:')),
	);
	expect(storedKeys.length).toBeGreaterThan(0);

	// Reset (confirm auto-accepted) wipes the persistent store...
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	const keysAfterReset = await page.evaluate(() =>
		Object.keys(window.localStorage).filter(
			(key) => key.startsWith('verse:') || key.startsWith('versemap:'),
		),
	);
	expect(keysAfterReset).toEqual([]);

	// ...so the next run starts from 0 again.
	await page.getByText('persistent-score.verse', { exact: true }).click();
	expect(await runOnce()).toBe(0);
});
