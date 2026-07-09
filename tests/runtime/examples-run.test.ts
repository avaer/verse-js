// examples-run.test.ts
// Runs the bundled IDE example files end-to-end through the new pipeline
// (with a virtual clock so Sleep-based examples finish instantly).

import { describe, expect, it } from 'vitest';
import { EXAMPLE_FILES } from '../../src/ide/examples.js';
import { VirtualClock } from '../../src/verse';
import { testHost } from '../helpers/test-host';

async function runExample(source: string): Promise<string[]> {
	const outcome = testHost.compile(source, { strict: true });
	if (!outcome.ok) {
		throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
	}
	const output: string[] = [];
	const clock = new VirtualClock();
	const run = testHost.run(outcome, {
		clock,
		rng: () => 0.5,
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			}
		},
	});
	await clock.run(run.done);
	return output;
}

describe('bundled examples', () => {
	it('hello-world.verse', async () => {
		expect(await runExample(EXAMPLE_FILES['hello-world.verse'])).toEqual([
			'Hello, world!',
			'2 + 2 = 4',
		]);
	});

	it('failure-rollback.verse', async () => {
		expect(await runExample(EXAMPLE_FILES['failure-rollback.verse'])).toEqual([
			'Withdrew 30 gold',
			'Withdrawal of 999 failed - the vault write was rolled back',
			'Final balance: 70 gold',
		]);
	});

	it('sleep-countdown.verse', async () => {
		expect(await runExample(EXAMPLE_FILES['sleep-countdown.verse'])).toEqual([
			'Countdown starting...',
			'3...',
			'2...',
			'1...',
			'Liftoff!',
		]);
	});

	it('random-dice.verse', async () => {
		const output = await runExample(EXAMPLE_FILES['random-dice.verse']);
		expect(output[0]).toBe('Rolling 5 dice:');
		expect(output).toHaveLength(8);
		expect(output[6]).toMatch(/^Total: \d+$/);
	});

	it('shapes-classes.verse', async () => {
		expect(await runExample(EXAMPLE_FILES['shapes-classes.verse'])).toEqual([
			'circle with area 12',
			'square with area 9',
			'favorite color: green',
		]);
	});

	it('race-and-sync.verse', async () => {
		const output = await runExample(EXAMPLE_FILES['race-and-sync.verse']);
		expect(output).toContain('cache finished at 1.0s');
		expect(output).toContain('race winner: cache');
		expect(output).toContain('network cleaned up');
		expect(output).toContain('sync got left and right at 3.0s');
		expect(output).not.toContain('network finished at 5.0s');
	});

	it('generics-options.verse', async () => {
		expect(await runExample(EXAMPLE_FILES['generics-options.verse'])).toEqual([
			'alice',
			'-1',
			'score is 49',
			'no score yet!',
		]);
	});

	it('persistent-score.verse', async () => {
		const output = await runExample(EXAMPLE_FILES['persistent-score.verse']);
		expect(output[0]).toMatch(/^you rolled \d+ \(best so far: 0\)$/);
		expect(output[1]).toBe('new high score!');
	});
});

describe('example files stay in sync with the workspace seeds', () => {
	it('every seed has a matching .verse file', async () => {
		const { readdir } = await import('node:fs/promises');
		const files = (await readdir(new URL('../../examples', import.meta.url)))
			.filter((f) => f.endsWith('.verse'))
			.sort();
		expect(Object.keys(EXAMPLE_FILES).sort()).toEqual(files);
	});
});
