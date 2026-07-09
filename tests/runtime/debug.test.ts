// debug.test.ts
// Debug-mode compilation: breakpoints, stepping, variable snapshots, and
// the task list surfaced while paused.

import { describe, expect, it } from 'vitest';
import { DebugSession } from '../../src/verse/debug/DebugSession';
import { compileProgram, compileVerse, getNativeRegistry, startRun } from '../../src/verse/pipeline';

interface DebugRunResult {
	output: string[];
	pauses: { line: number | null; variables: { name: string; value: string }[]; tasks: unknown[] }[];
}

async function runWithDebugger(
	source: string,
	options: {
		breakpoints: number[];
		/** Called on each pause; takes the stepping/resume action. */
		onPause?: (pause: DebugRunResult['pauses'][number], session: DebugSession) => void;
	},
): Promise<DebugRunResult> {
	const outcome = compileVerse(source, { strict: true });
	if (!outcome.ok) {
		throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
	}
	const compiled = compileProgram(
		outcome.program,
		getNativeRegistry(),
		outcome.check.globalSlotCount,
		outcome.check.deviceClasses,
		{ debug: true },
	);
	const output: string[] = [];
	const pauses: DebugRunResult['pauses'] = [];
	const session: DebugSession = new DebugSession({
		debugEnabled: true,
		breakpoints: options.breakpoints,
		onPaused: (info) => {
			const pause = { line: info.line, variables: info.variables, tasks: info.tasks };
			pauses.push(pause);
			// Let the runtime settle, then take the configured action.
			setTimeout(() => {
				if (options.onPause) {
					options.onPause(pause, session);
				} else {
					session.resume();
				}
			}, 0);
		},
	});
	const run = startRun(compiled, {
		debug: session,
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			}
		},
	});
	await run.done;
	return { output, pauses };
}

describe('debugger', () => {
	it('pauses at a breakpoint and resumes', async () => {
		const source = `X := 10
Y := 20
Print("{X + Y}")
`;
		const { output, pauses } = await runWithDebugger(source, { breakpoints: [2] });
		expect(pauses).toHaveLength(1);
		expect(pauses[0].line).toBe(2);
		expect(output).toEqual(['30']);
	});

	it('shows variables in scope while paused', async () => {
		const source = `Go() : void =
    A := 5
    B := 7
    Print("{A + B}")
Go()
`;
		const { pauses } = await runWithDebugger(source, { breakpoints: [4] });
		expect(pauses).toHaveLength(1);
		const names = pauses[0].variables.map((v) => v.name);
		expect(names).toContain('A');
		expect(names).toContain('B');
		const a = pauses[0].variables.find((v) => v.name === 'A');
		expect(a?.value).toBe('5');
	});

	it('step-over walks consecutive lines', async () => {
		const source = `A := 1
B := 2
C := 3
Print("{A + B + C}")
`;
		const lines: (number | null)[] = [];
		const { output } = await runWithDebugger(source, {
			breakpoints: [1],
			onPause: (pause, session) => {
				lines.push(pause.line);
				if (lines.length < 3) {
					session.stepOver();
				} else {
					session.resume();
				}
			},
		});
		expect(lines).toEqual([1, 2, 3]);
		expect(output).toEqual(['6']);
	});

	it('breakpoints hit inside spawned tasks and the task list is visible', async () => {
		const source = `using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Work()<suspends> : int =
    Sleep(0.0)
    Print("in task")
    42
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Work() }
        R := T.Await()
        Print("{R}")
`;
		const { output, pauses } = await runWithDebugger(source, { breakpoints: [5] });
		expect(pauses).toHaveLength(1);
		expect(pauses[0].line).toBe(5);
		// While paused inside the spawned task, the task list includes it.
		expect(pauses[0].tasks.length).toBeGreaterThan(0);
		expect(output).toEqual(['in task', '42']);
	});
});
