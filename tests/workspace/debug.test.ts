// debug.test.ts
// Multi-file debugging: per-file breakpoints, and file-aware pause info /
// call stacks when the entry file calls into a library file.

import { describe, expect, it } from 'vitest';
import { DebugSession, PausedInfo } from '../../src/verse/debug/DebugSession';
import { testHost } from '../helpers/test-host';

const FILES = {
	'lib.verse': `Compute(X : int) : int =
    Doubled := X * 2
    Doubled + 1
`,
	'main.verse': `Result := Compute(20)
Print("{Result}")
`,
};

async function runWorkspaceWithDebugger(
	breakpoints: Record<string, number[]>,
): Promise<{ output: string[]; pauses: PausedInfo[] }> {
	const outcome = testHost.compileWorkspace(FILES, { strict: true });
	if (!outcome.ok) {
		throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
	}
	const output: string[] = [];
	const pauses: PausedInfo[] = [];
	const session: DebugSession = new DebugSession({
		debugEnabled: true,
		breakpoints,
		onPaused: (info) => {
			pauses.push(info);
			setTimeout(() => session.resume(), 0);
		},
	});
	const run = testHost.run(outcome, {
		debug: session,
		entry: 'main.verse',
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			}
		},
	});
	await run.done;
	return { output, pauses };
}

describe('workspace debugging', () => {
	it('hits a breakpoint in a library file called from the entry file', async () => {
		const { output, pauses } = await runWorkspaceWithDebugger({ 'lib.verse': [2] });
		expect(pauses).toHaveLength(1);
		expect(pauses[0].file).toBe('lib.verse');
		expect(pauses[0].line).toBe(2);
		// The call stack shows the library function with its file.
		const top = pauses[0].callStack[0];
		expect(top.name).toBe('Compute');
		expect(top.file).toBe('lib.verse');
		expect(output).toEqual(['41']);
	});

	it('per-file breakpoints do not fire on the same line of other files', async () => {
		// Line 2 exists in both files; only main.verse's should hit.
		const { output, pauses } = await runWorkspaceWithDebugger({ 'main.verse': [2] });
		expect(pauses).toHaveLength(1);
		expect(pauses[0].file).toBe('main.verse');
		expect(pauses[0].line).toBe(2);
		expect(output).toEqual(['41']);
	});

	it('breakpoints in a library file fire even with none in the entry file', async () => {
		const { pauses } = await runWorkspaceWithDebugger({
			'lib.verse': [3],
			'main.verse': [],
		});
		expect(pauses).toHaveLength(1);
		expect(pauses[0].file).toBe('lib.verse');
		expect(pauses[0].line).toBe(3);
		// Doubled is visible in the paused frame.
		const doubled = pauses[0].variables.find((v) => v.name === 'Doubled');
		expect(doubled?.value).toBe('40');
	});
});
